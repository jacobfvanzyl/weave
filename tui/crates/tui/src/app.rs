//! The event loop: terminal input and agent events in, frames and protocol calls out.
//!
//! Requests whose answers the UI waits on (settings, session lists, opening sessions) run on
//! their own tasks and report back as [`AppEvent`]s, so the loop never blocks on the agent.

use std::collections::HashMap;
use std::time::Duration;
use std::time::Instant;

use crossterm::event::Event;
use crossterm::event::KeyEventKind;
use tokio::sync::mpsc;
use tokio::sync::mpsc::UnboundedReceiver;
use tokio::sync::oneshot;
use tokio::time::MissedTickBehavior;
use weave_acp_core::AgentConnection;
use weave_acp_core::AgentEvent;
use weave_acp_core::AgentHandle;
use weave_acp_core::SessionSetup;
use weave_acp_core::schema::Error;
use weave_acp_core::schema::ListSessionsResponse;
use weave_acp_core::schema::SessionConfigOption;
use weave_acp_core::schema::SessionId;
use weave_acp_core::schema::TerminalExitStatus;

use crate::attachments::prompt_blocks;
use crate::chat::AppCommand;
use crate::chat::ChatWidget;
use crate::chat::SessionAbilities;
use crate::clipboard;
use crate::footer::StatusItem;
use crate::input::Input;
use crate::session::OpenedSession;
use crate::session::SessionTarget;
use crate::session::open_session;
use crate::settings::SettingChange;
use crate::tui::ScreenMode;
use crate::tui::Tui;

/// Animation frame interval while a turn runs.
const FRAME_INTERVAL: Duration = Duration::from_millis(80);
/// Agent events applied per frame before input gets a turn.
const EVENTS_PER_FRAME: usize = 256;

/// An initialized agent connection, ready for the interactive client.
pub struct Session {
    pub connection: AgentConnection,
    pub events: UnboundedReceiver<AgentEvent>,
    pub agent_name: String,
    pub agent_version: Option<String>,
    /// How sessions opened from the TUI are set up.
    pub setup: SessionSetup,
    /// The session to start in, or `None` to start in the session picker.
    pub opened: Option<OpenedSession>,
    /// Things worth telling the user at startup, such as skipped MCP servers.
    pub notices: Vec<String>,
}

/// How the client looks.
pub struct UiOptions {
    pub screen: ScreenMode,
    /// What the footer's status line shows; empty shows `? for shortcuts` instead.
    pub status_line: Vec<StatusItem>,
    /// Desktop notifications when a turn ends or the agent needs you, while unfocused.
    pub notifications: bool,
    /// Keep the window title on the session and what the agent is doing.
    pub terminal_title: bool,
    /// The Vim composer, for new blank threads and multi-line drafts.
    pub vim: bool,
    /// Sessions outlive the TUI, in the weave daemon: leaving with Ctrl+D keeps a turn running.
    pub detachable: bool,
}

/// How the client ended.
pub struct Exit {
    /// The session to offer reopening: the active one, if it had a conversation.
    pub resumable_session: Option<SessionId>,
    /// Whether its turn was still running, to carry on in the weave daemon.
    pub turn_running: bool,
    /// `/reload`: start again in place, reattaching to `active_session`.
    pub reload: bool,
    /// The session shown when it ended, conversation or not.
    pub active_session: Option<SessionId>,
}

/// Results of requests the loop made off the UI thread.
enum AppEvent {
    SettingChanged(
        SettingChange,
        Result<Option<Vec<SessionConfigOption>>, Error>,
    ),
    SessionsListed(Result<ListSessionsResponse, Error>, bool),
    SessionOpened {
        result: Result<OpenedSession, Error>,
        previous: Option<SessionId>,
    },
    SessionDeleted(SessionId, Result<(), Error>),
    /// The clipboard's image, saved for attaching, or why there wasn't one.
    ImagePasted(Result<std::path::PathBuf, String>),
    /// Output from a shell-mode command, then how it ended.
    ShellOutput(String, String),
    ShellExited(String, TerminalExitStatus),
}

/// Run the interactive client until the user quits, then close the connection.
pub async fn run(session: Session, ui: UiOptions) -> anyhow::Result<Exit> {
    let UiOptions {
        screen,
        status_line,
        notifications,
        terminal_title,
        vim,
        detachable,
    } = ui;
    let Session {
        connection,
        mut events,
        agent_name,
        agent_version,
        mut setup,
        opened,
        notices,
    } = session;
    // The session works where the daemon says, and so does this client.
    if let Some(cwd) = opened.as_ref().and_then(|opened| opened.cwd.clone()) {
        setup.cwd = cwd;
    }
    let capabilities = connection
        .agent()
        .map(|agent| agent.agent_capabilities.clone())
        .unwrap_or_default();
    let abilities = SessionAbilities {
        list: capabilities.session_capabilities.list.is_some(),
        delete: capabilities.session_capabilities.delete.is_some(),
    };
    let mut tui = Tui::init(screen)?;
    let size = tui.size()?;
    let mut chat = ChatWidget::new(agent_name, setup.cwd.clone(), abilities, size.width)
        .with_status_line(status_line)
        .with_vim(vim)
        .with_detach(detachable);
    chat.set_size(size.width, size.height);
    if screen == ScreenMode::Fullscreen {
        chat = chat.fullscreen();
    }
    let mut app = App {
        handle: connection.handle(),
        setup,
        results: None,
        notifications,
        terminal_title,
        focused: true,
        shells: HashMap::new(),
        reload: false,
    };
    let startup = match opened {
        Some(opened) => {
            chat.begin_session(opened.session_id.clone(), None);
            chat.session_ready(opened);
            Vec::new()
        }
        None => chat.open_session_picker(true),
    };
    chat.push_header(agent_version.as_deref(), &notices);
    let result = app.run(&mut tui, &mut chat, &mut events, startup).await;
    tui.exit();
    connection.shutdown().await;
    result.map(|()| Exit {
        resumable_session: chat.resumable_session().cloned(),
        turn_running: chat.turn_running(),
        reload: app.reload,
        active_session: chat.active_session().cloned(),
    })
}

struct App {
    handle: AgentHandle,
    setup: SessionSetup,
    results: Option<mpsc::UnboundedSender<AppEvent>>,
    notifications: bool,
    terminal_title: bool,
    /// Whether the terminal has focus, from its focus reports.
    focused: bool,
    /// Shell-mode commands still running, by id, and how to stop each.
    shells: HashMap<String, oneshot::Sender<()>>,
    /// Quitting to start again in place (`/reload`).
    reload: bool,
}

impl App {
    async fn run(
        &mut self,
        tui: &mut Tui,
        chat: &mut ChatWidget,
        events: &mut UnboundedReceiver<AgentEvent>,
        startup: Vec<AppCommand>,
    ) -> anyhow::Result<()> {
        let mut input = Input::start();
        let (app_tx, mut app_events) = mpsc::unbounded_channel();
        self.results = Some(app_tx);
        let mut frames = tokio::time::interval(FRAME_INTERVAL);
        frames.set_missed_tick_behavior(MissedTickBehavior::Skip);
        if self.execute(tui, chat, startup) {
            return Ok(());
        }
        loop {
            if self.terminal_title {
                tui.set_title(&chat.terminal_title(Instant::now()));
            }
            draw(tui, chat)?;
            tui.set_cursor_shape(chat.cursor_shape());
            let commands = tokio::select! {
                event = input.next() => match event {
                    Some(Ok(Event::FocusGained)) => {
                        self.focused = true;
                        Vec::new()
                    }
                    Some(Ok(Event::FocusLost)) => {
                        self.focused = false;
                        Vec::new()
                    }
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
                Some(event) = app_events.recv() => self.handle_app_event(chat, event),
                _ = frames.tick(), if chat.is_animating() => {
                    chat.tick(Instant::now());
                    Vec::new()
                }
            };
            if self.execute(tui, chat, commands) {
                return Ok(());
            }
        }
    }

    fn handle_app_event(&mut self, chat: &mut ChatWidget, event: AppEvent) -> Vec<AppCommand> {
        match event {
            AppEvent::SettingChanged(change, result) => {
                chat.setting_changed(change, result);
                Vec::new()
            }
            AppEvent::SessionsListed(result, append) => {
                chat.sessions_listed(result, append);
                Vec::new()
            }
            AppEvent::SessionOpened { result, previous } => match result {
                Ok(opened) => {
                    // Free the session we left, if the agent lets us.
                    if let Some(previous) =
                        previous.filter(|previous| *previous != opened.session_id)
                    {
                        let supported = self.handle.agent().is_some_and(|agent| {
                            agent
                                .agent_capabilities
                                .session_capabilities
                                .close
                                .is_some()
                        });
                        if supported {
                            let handle = self.handle.clone();
                            tokio::spawn(async move { handle.close_session(previous).await });
                        }
                    }
                    // It works where the daemon says, and so does this client from now on.
                    if let Some(cwd) = opened.cwd.clone() {
                        self.setup.cwd.clone_from(&cwd);
                        chat.set_cwd(cwd);
                    }
                    chat.session_ready(opened);
                    Vec::new()
                }
                Err(error) => chat.session_failed(&error, previous),
            },
            AppEvent::SessionDeleted(session_id, result) => {
                chat.session_deleted(&session_id, result);
                Vec::new()
            }
            AppEvent::ImagePasted(Ok(path)) => {
                chat.attach_image(path);
                Vec::new()
            }
            AppEvent::ImagePasted(Err(reason)) => {
                chat.report_info(&format!("Couldn't paste an image: {reason}"));
                Vec::new()
            }
            AppEvent::ShellOutput(id, text) => {
                chat.shell_output(&id, &text);
                Vec::new()
            }
            AppEvent::ShellExited(id, status) => {
                self.shells.remove(&id);
                chat.shell_exited(&id, status);
                Vec::new()
            }
        }
    }

    /// Carry out commands. Returns whether the user quit.
    fn execute(&mut self, tui: &mut Tui, chat: &mut ChatWidget, commands: Vec<AppCommand>) -> bool {
        for command in commands {
            match command {
                AppCommand::Prompt(text) => {
                    let Some(session_id) = chat.active_session().cloned() else {
                        continue;
                    };
                    let capabilities = self
                        .handle
                        .agent()
                        .map(|agent| agent.agent_capabilities.prompt_capabilities.clone())
                        .unwrap_or_default();
                    let images = chat.prompt_images(&text);
                    let (prompt, attachments) =
                        prompt_blocks(&text, &self.setup.cwd, &capabilities, &images);
                    chat.note_attachments(&attachments);
                    if let Err(error) = self.handle.prompt(session_id, prompt) {
                        chat.prompt_failed(&error);
                    }
                }
                AppCommand::Cancel => {
                    if let Some(session_id) = chat.active_session().cloned()
                        && let Err(error) = self.handle.cancel(session_id)
                    {
                        tracing::warn!(%error, "failed to send session/cancel");
                    }
                }
                // A subagent's cancel is the ordinary `session/cancel`, for its session.
                AppCommand::CancelSubagent(session_id) => {
                    if let Err(error) = self.handle.cancel(session_id) {
                        tracing::warn!(%error, "failed to send session/cancel to a subagent");
                    }
                }
                AppCommand::ChangeSetting(change) => {
                    if let Some(session_id) = chat.active_session().cloned() {
                        self.spawn_setting_change(session_id, change);
                    }
                }
                AppCommand::ListSessions {
                    all_directories,
                    cursor,
                } => {
                    let cwd = (!all_directories).then(|| self.setup.cwd.clone());
                    let append = cursor.is_some();
                    let handle = self.handle.clone();
                    self.spawn(async move {
                        AppEvent::SessionsListed(handle.list_sessions(cwd, cursor).await, append)
                    });
                }
                AppCommand::OpenSession { target, title, cwd } => {
                    let previous = chat.active_session().cloned();
                    // Show the target's events from now on, so a load's replay lands in place.
                    if let SessionTarget::Existing(session_id) = &target {
                        let title = title.unwrap_or_else(|| session_id.to_string());
                        chat.begin_session(session_id.clone(), Some(&title));
                    }
                    let handle = self.handle.clone();
                    // A session from another directory reopens in its own.
                    let setup = SessionSetup {
                        cwd: cwd.unwrap_or_else(|| self.setup.cwd.clone()),
                        ..self.setup.clone()
                    };
                    self.spawn(async move {
                        let result = open_session(&handle, target, &setup).await;
                        AppEvent::SessionOpened { result, previous }
                    });
                }
                AppCommand::DeleteSession(session_id) => {
                    let handle = self.handle.clone();
                    self.spawn(async move {
                        let result = handle.delete_session(session_id.clone()).await;
                        AppEvent::SessionDeleted(session_id, result)
                    });
                }
                AppCommand::OpenUrl(url) => open_in_browser(&url),
                // Handled in the run loop.
                AppCommand::RunShell { id, command } => {
                    if let Some(results) = self.results.clone() {
                        let (kill, killed) = oneshot::channel();
                        self.shells.insert(id.clone(), kill);
                        let cwd = self.setup.cwd.clone();
                        tokio::spawn(run_shell(id, command, cwd, results, killed));
                    }
                }
                AppCommand::PasteImage => {
                    self.spawn(async {
                        let saved = tokio::task::spawn_blocking(clipboard::save_image).await;
                        AppEvent::ImagePasted(saved.unwrap_or_else(|error| Err(error.to_string())))
                    });
                }
                AppCommand::KillShell(id) => {
                    if let Some(kill) = self.shells.remove(&id) {
                        let _ = kill.send(());
                    }
                }
                AppCommand::Copy(text) => tui.copy(&text),
                // As Codex, only while the terminal isn't in front of the user.
                AppCommand::Notify(message) => {
                    if self.notifications && !self.focused {
                        tui.notify(&message);
                    }
                }
                AppCommand::Quit => return true,
                AppCommand::Reload => {
                    self.reload = true;
                    return true;
                }
            }
        }
        false
    }

    fn spawn_setting_change(&self, session_id: SessionId, change: SettingChange) {
        let handle = self.handle.clone();
        self.spawn(async move {
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
            AppEvent::SettingChanged(change, result)
        });
    }

    fn spawn(&self, task: impl Future<Output = AppEvent> + Send + 'static) {
        if let Some(results) = self.results.clone() {
            tokio::spawn(async move {
                let _ = results.send(task.await);
            });
        }
    }
}

/// Run a shell-mode command in `cwd`, streaming its output (stdout and stderr together, as
/// a terminal shows them) until it exits or `killed` fires.
async fn run_shell(
    id: String,
    command: String,
    cwd: std::path::PathBuf,
    results: mpsc::UnboundedSender<AppEvent>,
    killed: oneshot::Receiver<()>,
) {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "sh".to_owned());
    let spawned = tokio::process::Command::new(&shell)
        .arg("-c")
        .arg(&command)
        .current_dir(&cwd)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn();
    let mut child = match spawned {
        Ok(child) => child,
        Err(error) => {
            let _ = results.send(AppEvent::ShellOutput(
                id.clone(),
                format!("{shell}: {error}\n"),
            ));
            let status = TerminalExitStatus::new().exit_code(127);
            let _ = results.send(AppEvent::ShellExited(id, status));
            return;
        }
    };
    let forward = |stream: Option<Box<dyn tokio::io::AsyncRead + Unpin + Send>>| {
        let results = results.clone();
        let id = id.clone();
        tokio::spawn(async move {
            use tokio::io::AsyncReadExt;
            let Some(mut stream) = stream else {
                return;
            };
            let mut buffer = [0_u8; 4096];
            while let Ok(read) = stream.read(&mut buffer).await {
                if read == 0 {
                    break;
                }
                let text = String::from_utf8_lossy(&buffer[..read]).into_owned();
                if results
                    .send(AppEvent::ShellOutput(id.clone(), text))
                    .is_err()
                {
                    break;
                }
            }
        })
    };
    let stdout = forward(child.stdout.take().map(|out| Box::new(out) as _));
    let stderr = forward(child.stderr.take().map(|err| Box::new(err) as _));
    let status = tokio::select! {
        status = child.wait() => status,
        _ = killed => {
            let _ = child.start_kill();
            child.wait().await
        }
    };
    // All output is in before the exit is reported.
    let _ = stdout.await;
    let _ = stderr.await;
    let status = match status {
        Ok(status) => exit_status(status),
        Err(error) => {
            let _ = results.send(AppEvent::ShellOutput(id.clone(), format!("{error}\n")));
            TerminalExitStatus::new().exit_code(1)
        }
    };
    let _ = results.send(AppEvent::ShellExited(id, status));
}

fn exit_status(status: std::process::ExitStatus) -> TerminalExitStatus {
    #[cfg(unix)]
    let signal = {
        use std::os::unix::process::ExitStatusExt;
        status.signal().map(|signal| match signal {
            1 => "SIGHUP".to_owned(),
            2 => "SIGINT".to_owned(),
            9 => "SIGKILL".to_owned(),
            15 => "SIGTERM".to_owned(),
            other => format!("signal {other}"),
        })
    };
    #[cfg(not(unix))]
    let signal = None;
    TerminalExitStatus::new()
        .exit_code(status.code().and_then(|code| u32::try_from(code).ok()))
        .signal(signal)
}

/// Open a URL the user explicitly consented to, in their default browser. Nothing here fetches it.
fn open_in_browser(url: &str) {
    #[cfg(target_os = "macos")]
    let mut command = std::process::Command::new("open");
    #[cfg(all(unix, not(target_os = "macos")))]
    let mut command = std::process::Command::new("xdg-open");
    #[cfg(windows)]
    let mut command = {
        let mut command = std::process::Command::new("cmd");
        command.args(["/C", "start", ""]);
        command
    };
    let spawned = command
        .arg(url)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn();
    if let Err(error) = spawned {
        tracing::warn!(%error, "failed to open the browser");
    }
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
        Event::Mouse(event) => chat.handle_mouse(event),
        Event::Resize(width, height) => {
            chat.set_size(width, height);
            Vec::new()
        }
        _ => Vec::new(),
    }
}

fn draw(tui: &mut Tui, chat: &mut ChatWidget) -> std::io::Result<()> {
    // Inline mode shows the Ctrl+T transcript on the alternate screen, as Codex's pager.
    if tui.mode() == ScreenMode::Inline && chat.overlay_open() {
        tui.enter_overlay()?;
        return tui.draw_screen(|frame| {
            let area = frame.area();
            chat.render_pager(area, frame.buffer_mut());
        });
    }
    if tui.overlay_open() {
        tui.leave_overlay()?;
    }
    if tui.mode() == ScreenMode::Fullscreen {
        return tui.draw_screen(|frame| {
            let area = frame.area();
            if let Some(cursor) = chat.render_screen(area, frame.buffer_mut()) {
                frame.set_cursor_position(cursor);
            }
        });
    }
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
