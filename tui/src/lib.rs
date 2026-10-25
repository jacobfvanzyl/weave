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
mod events;
mod file_popup;
mod find;
mod footer;
mod graphics;
mod highlight;
mod history_cell;
mod input;
mod insert_history;
mod links;
mod markdown;
mod math;
mod mermaid;
mod notify;
mod palette;
mod permission;
#[cfg(test)]
mod render_snapshots;
mod runs;
mod session;
mod session_picker;
mod settings;
mod status;
mod streaming;
mod style;
mod subagents;
#[cfg(test)]
mod test_backend;
mod thumbnails;
mod tool_call;
mod tool_output;
mod transcript;
mod tui;
mod updates;
mod vim;
mod wrapping;

pub use app::Exit;
pub use app::Reconnection;
pub use app::Reconnector;
pub use app::Session;
pub use app::UiOptions;
pub use app::run;
pub use footer::StatusItem;
pub use markdown::Rendering;
pub use tui::ScreenMode;

/// Where the versions whose update notice the user dismissed are kept.
pub fn dismissed_updates_file() -> Option<std::path::PathBuf> {
    updates::Dismissed::default_location()
}
