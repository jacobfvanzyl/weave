//! The config file as this client reads it: its own sections, `[tui]` and `[daemon]`, and the
//! Host's (`weave_agents::config`), for running agents outside the Host.

use std::path::Path;

use anyhow::Context;
use serde::Deserialize;
use serde::de::DeserializeOwned;

pub struct Config {
    /// The file as a whole, for its agent and MCP server sections.
    pub agents: weave_agents::Config,
    pub tui: TuiConfig,
    pub daemon: DaemonSettings,
    /// Worth telling the user: the file read is `tui.toml`, which should be renamed.
    pub notice: Option<String>,
}

/// The per-user daemon that runs agents (`weave daemon`).
#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DaemonSettings {
    /// Run agents in the daemon, so sessions outlive the TUI (default true). Without it each
    /// `weave` runs its own, as `--no-daemon` does.
    pub enabled: Option<bool>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TuiConfig {
    #[serde(default)]
    pub alternate_screen: AlternateScreen,
    /// Footer status line items, as Codex's `tui.status_line`: model, agent, mode,
    /// directory, session, context (the percentage used), and cost (at the right). Defaults
    /// to agent, model, mode, context, session and cost.
    pub status_line: Option<Vec<String>>,
    /// Desktop notifications when a turn ends or the agent needs you (default true).
    pub notifications: Option<bool>,
    /// Keep the window title on the session and activity (default true).
    pub terminal_title: Option<bool>,
    /// The Vim composer, with relative line numbers, for new blank threads and multi-line
    /// drafts; Ctrl+G switches to and from it (default false).
    pub vim: Option<bool>,
    /// Thumbnails of pasted images above the composer, in terminals that draw images.
    #[serde(default)]
    pub images: Images,
}

/// Whether to show images, in terminals that draw them with Kitty graphics placeholders.
#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Images {
    /// Where the terminal is known to draw them and says it does.
    #[default]
    Auto,
    Never,
}

/// Whether to run fullscreen on the alternate screen, as Codex's `tui.alternate_screen`.
#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AlternateScreen {
    /// Fullscreen; reserved for exceptions where it works badly, as Codex makes for
    /// Terminal.app over SSH.
    #[default]
    Auto,
    Always,
    /// Inline: a viewport below the prompt, with history in the terminal's scrollback.
    Never,
}

impl Config {
    /// Load `path`, or the default location. A missing default file is an empty config.
    pub fn load(path: Option<&Path>) -> anyhow::Result<Self> {
        let loaded = weave_agents::Config::load(path)?;
        Ok(Self {
            tui: section(&loaded.config.tui, "tui")?,
            daemon: section(&loaded.config.daemon, "daemon")?,
            agents: loaded.config,
            notice: loaded.notice,
        })
    }
}

fn section<T: DeserializeOwned>(table: &toml::Table, name: &str) -> anyhow::Result<T> {
    toml::Value::Table(table.clone())
        .try_into()
        .with_context(|| format!("reading the config file's [{name}]"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unknown_keys_in_the_clients_sections_are_rejected() {
        let config: weave_agents::Config =
            toml::from_str("[tui]\nalternate_screen = \"sometimes\"").expect("the Host's view");
        assert!(section::<TuiConfig>(&config.tui, "tui").is_err());
        let config: weave_agents::Config =
            toml::from_str("[tui]\nvim = true\nimages = \"never\"\n[daemon]\nenabled = false")
                .expect("valid");
        let tui: TuiConfig = section(&config.tui, "tui").expect("tui");
        let daemon: DaemonSettings = section(&config.daemon, "daemon").expect("daemon");
        assert_eq!(
            (tui.vim, tui.images, daemon.enabled),
            (Some(true), Images::Never, Some(false))
        );
    }
}
