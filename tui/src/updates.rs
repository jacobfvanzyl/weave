//! Newer versions of the session's agent (WVE-93): the Host's notice of one, `/update`, which
//! moves the agent's new sessions to it (`agents/update`) and then this one
//! (`session/reopen`), and the versions the user dismissed. A dismissed version stays quiet
//! until a newer one is out, as Codex's update notice does: after openai/codex
//! `codex-rs/tui/src/updates.rs` (Apache-2.0), which keeps its dismissed version in a file
//! the same way. Here it's `$XDG_STATE_HOME/weave/updates.json`.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::time::Instant;

use ratatui::style::Style;
use ratatui::style::Stylize;
use ratatui::text::Line;
use ratatui::text::Span;
use serde::Deserialize;
use serde::Serialize;
use weave_acp_core::schema::SessionId;
use weave_host_protocol::agents::AgentRelease;
use weave_host_protocol::agents::AgentUpdate;

use crate::style::dim;
use crate::wrapping::DisplayLine;
use crate::wrapping::wrap_sourced;

/// The slash command, handled here rather than by the agent.
pub const COMMAND: &str = "update";
pub const COMMAND_DESCRIPTION: &str =
    "Move this thread to its agent's newest version; `/update dismiss` hides the notice";
/// What `/update` takes to dismiss the notice.
pub const DISMISS: &str = "dismiss";

/// `/update` while it runs, for the status line.
#[derive(Clone, Debug)]
pub struct Task {
    /// The session it moves.
    pub session_id: SessionId,
    pub stage: Stage,
    pub started: Instant,
    /// What the agent is called, as the notice names it.
    pub name: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Stage {
    /// `agents/update`: checking that the newest version starts.
    Checking,
    /// `session/reopen` to this version, once any turn ends.
    Moving(String),
}

impl Task {
    pub fn label(&self) -> String {
        match &self.stage {
            Stage::Checking => format!("Updating {}", self.name),
            Stage::Moving(version) => format!("Moving this thread to {version}"),
        }
    }

    pub fn hint(&self, turn_running: bool) -> &'static str {
        match (&self.stage, turn_running) {
            (Stage::Checking, _) => "checking that the newest version starts",
            (Stage::Moving(_), true) => "once this turn ends",
            (Stage::Moving(_), false) => "reopening it",
        }
    }
}

/// A package or registry agent as people read it: without an npm scope.
pub fn short_name(name: &str) -> &str {
    match name.strip_prefix('@') {
        Some(scoped) => scoped.split_once('/').map_or(name, |(_, package)| package),
        None => name,
    }
}

/// The notice: which version is out, which one this session runs, and what to do.
pub fn notice_lines(update: &AgentUpdate, width: usize) -> Vec<DisplayLine> {
    let first = Line::from(vec![
        Span::from(format!("{} {}", short_name(&update.name), update.latest)).bold(),
        Span::from(format!(" is out; this thread runs {}.", update.running)),
    ]);
    let second = Line::from(vec![
        Span::from("/update").cyan(),
        Span::styled(" moves it over · ", dim()),
        Span::from("/update dismiss").cyan(),
        Span::styled(" hides this version", dim()),
    ]);
    let mut lines = wrap_sourced(
        &first,
        width,
        &Line::from(Span::styled("✨ ", Style::default())),
        &Line::from("   "),
    );
    lines.extend(wrap_sourced(
        &second,
        width,
        &Line::from("   "),
        &Line::from("   "),
    ));
    lines
}

/// What the transcript says when the session's agent was started again.
pub fn reopened_text(
    release: Option<&AgentRelease>,
    previous: Option<&AgentRelease>,
    failed: Option<&str>,
) -> String {
    match (release, failed) {
        (Some(release), Some(failed)) => format!(
            "{failed}; it runs {} {} again",
            short_name(&release.name),
            release.version
        ),
        (None, Some(failed)) => format!("{failed}; it runs the agent it ran again"),
        (Some(release), None) => match previous {
            Some(previous) if previous.version != release.version => format!(
                "Moved this thread to {} {}, from {}",
                short_name(&release.name),
                release.version,
                previous.version
            ),
            _ => format!(
                "Reopened this thread on {} {}",
                short_name(&release.name),
                release.version
            ),
        },
        (None, None) => "Reopened this thread in a new agent process".to_owned(),
    }
}

/// The versions the user dismissed, by agent id, kept between runs.
#[derive(Debug, Default)]
pub struct Dismissed {
    path: Option<PathBuf>,
    versions: BTreeMap<String, String>,
}

#[derive(Default, Serialize, Deserialize)]
struct Stored {
    #[serde(default)]
    dismissed: BTreeMap<String, String>,
}

impl Dismissed {
    /// `$XDG_STATE_HOME/weave/updates.json`, by default under `~/.local/state`.
    pub fn default_location() -> Option<PathBuf> {
        let state = std::env::var_os("XDG_STATE_HOME")
            .filter(|dir| !dir.is_empty())
            .map(PathBuf::from)
            .or_else(|| {
                std::env::var_os("HOME")
                    .filter(|home| !home.is_empty())
                    .map(|home| PathBuf::from(home).join(".local/state"))
            })?;
        Some(state.join("weave/updates.json"))
    }

    /// The versions dismissed at `path`; none without one, or when it can't be read.
    pub fn load(path: Option<PathBuf>) -> Self {
        let versions = path
            .as_ref()
            .and_then(|path| std::fs::read(path).ok())
            .and_then(|bytes| serde_json::from_slice::<Stored>(&bytes).ok())
            .map(|stored| stored.dismissed)
            .unwrap_or_default();
        Self { path, versions }
    }

    pub fn versions(&self) -> &BTreeMap<String, String> {
        &self.versions
    }

    /// Hide `version` of `agent_id` from now on. Best effort: a failure to write only means
    /// the notice comes back next time.
    pub fn dismiss(&mut self, agent_id: &str, version: &str) {
        self.versions
            .insert(agent_id.to_owned(), version.to_owned());
        let Some(path) = &self.path else {
            return;
        };
        let stored = Stored {
            dismissed: self.versions.clone(),
        };
        let written = serde_json::to_vec_pretty(&stored)
            .map_err(std::io::Error::other)
            .and_then(|json| {
                if let Some(dir) = path.parent() {
                    std::fs::create_dir_all(dir)?;
                }
                std::fs::write(path, json)
            });
        if let Err(error) = written {
            tracing::debug!(%error, path = %path.display(), "couldn't keep a dismissed update");
        }
    }
}

#[cfg(test)]
mod tests {
    use pretty_assertions::assert_eq;

    use super::*;

    #[test]
    fn scopes_are_left_out_of_names() {
        assert_eq!(
            short_name("@agentclientprotocol/claude-agent-acp"),
            "claude-agent-acp"
        );
        assert_eq!(short_name("OpenCode"), "OpenCode");
        assert_eq!(short_name("@odd"), "@odd");
    }

    #[test]
    fn dismissed_versions_are_kept_between_runs() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("weave/updates.json");
        let mut dismissed = Dismissed::load(Some(path.clone()));
        assert!(dismissed.versions().is_empty());
        dismissed.dismiss("claude", "0.93.0");
        let again = Dismissed::load(Some(path));
        assert_eq!(
            again.versions().get("claude").map(String::as_str),
            Some("0.93.0")
        );
    }
}
