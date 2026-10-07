//! The interactive terminal client, following the structure of Codex CLI's TUI: an inline
//! viewport for live content above the shell, with finished history written into the
//! terminal's native scrollback.

mod app;
mod chat;
mod command_popup;
mod composer;
mod custom_terminal;
mod history_cell;
mod insert_history;
mod markdown;
mod permission;
mod settings;
mod status;
mod streaming;
#[cfg(test)]
mod test_backend;
mod tool_output;
mod tui;
mod wrapping;

pub use app::Session;
pub use app::run;
