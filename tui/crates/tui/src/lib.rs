//! The interactive terminal client, following the structure of Codex CLI's TUI. By default
//! it runs fullscreen on the alternate screen and draws and scrolls the transcript itself;
//! inline mode instead keeps a viewport below the shell prompt and writes finished history
//! into the terminal's native scrollback.

mod app;
mod attachments;
mod chat;
mod clipboard;
mod command_popup;
mod compaction;
mod composer;
mod conventions;
mod custom_terminal;
mod elicitation;
mod file_popup;
mod find;
mod footer;
mod highlight;
mod history_cell;
mod input;
mod insert_history;
mod markdown;
mod notify;
mod palette;
mod permission;
#[cfg(test)]
mod render_snapshots;
mod session;
mod session_picker;
mod settings;
mod status;
mod streaming;
mod style;
mod subagents;
#[cfg(test)]
mod test_backend;
mod tool_call;
mod tool_output;
mod transcript;
mod tui;
mod vim;
mod wrapping;

pub use app::Exit;
pub use app::Reconnection;
pub use app::Reconnector;
pub use app::Session;
pub use app::UiOptions;
pub use app::run;
pub use footer::StatusItem;
pub use session::OpenedSession;
pub use session::Reopened;
pub use session::SessionTarget;
pub use session::open_session;
pub use tui::ScreenMode;
