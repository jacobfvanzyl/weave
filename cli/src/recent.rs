//! The agent last used in each directory, so `weave --continue` reopens its session without
//! being told which agent: `$XDG_STATE_HOME/weave/recent.json`
//! (`~/.local/state/weave/recent.json`).

use std::collections::BTreeMap;
use std::path::Path;
use std::path::PathBuf;
use std::time::SystemTime;
use std::time::UNIX_EPOCH;

use serde::Deserialize;
use serde::Serialize;

use crate::args::AgentChoice;

/// Directories remembered at most; the least recently used go first.
const LIMIT: usize = 500;

pub struct Recent {
    path: PathBuf,
}

#[derive(Default, Serialize, Deserialize)]
struct Remembered {
    #[serde(default)]
    directories: BTreeMap<PathBuf, Used>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Used {
    agent: AgentChoice,
    used_at_ms: u64,
}

impl Recent {
    pub fn at(path: PathBuf) -> Self {
        Self { path }
    }

    /// `$XDG_STATE_HOME/weave/recent.json`, by default under `~/.local/state`.
    pub fn default_location() -> Option<Self> {
        let state = std::env::var_os("XDG_STATE_HOME")
            .filter(|dir| !dir.is_empty())
            .map(PathBuf::from)
            .or_else(|| {
                std::env::var_os("HOME")
                    .filter(|home| !home.is_empty())
                    .map(|home| PathBuf::from(home).join(".local/state"))
            })?;
        Some(Self::at(state.join("weave/recent.json")))
    }

    /// The agent last used in `cwd`.
    pub fn last_in(&self, cwd: &Path) -> Option<AgentChoice> {
        self.read().directories.remove(cwd).map(|used| used.agent)
    }

    /// Remember `agent` as the one last used in `cwd`. Best effort: a failure only means
    /// `--continue` falls back to the default agent.
    pub fn record(&self, cwd: &Path, agent: &AgentChoice) {
        let mut remembered = self.read();
        remembered.directories.insert(
            cwd.to_owned(),
            Used {
                agent: agent.clone(),
                used_at_ms: now_ms(),
            },
        );
        while remembered.directories.len() > LIMIT {
            let oldest = remembered
                .directories
                .iter()
                .min_by_key(|(_, used)| used.used_at_ms)
                .map(|(dir, _)| dir.clone());
            match oldest {
                Some(oldest) => remembered.directories.remove(&oldest),
                None => break,
            };
        }
        if let Err(error) = self.write(&remembered) {
            tracing::debug!(%error, path = %self.path.display(), "couldn't remember the agent");
        }
    }

    fn read(&self) -> Remembered {
        std::fs::read_to_string(&self.path)
            .ok()
            .and_then(|text| serde_json::from_str(&text).ok())
            .unwrap_or_default()
    }

    /// Replace the file whole, so a concurrent reader never sees half of it.
    fn write(&self, remembered: &Remembered) -> std::io::Result<()> {
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let text = serde_json::to_string_pretty(remembered).map_err(std::io::Error::other)?;
        let staging = self
            .path
            .with_extension(format!("json.{}", std::process::id()));
        std::fs::write(&staging, text)?;
        std::fs::rename(&staging, &self.path)
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| {
            u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX)
        })
}

#[cfg(test)]
mod tests {
    use pretty_assertions::assert_eq;

    use super::*;

    #[test]
    fn each_directory_remembers_its_last_agent() {
        let dir = tempfile::tempdir().expect("tempdir");
        let recent = Recent::at(dir.path().join("state/weave/recent.json"));
        let repo = Path::new("/repo");
        assert_eq!(recent.last_in(repo), None);

        recent.record(repo, &AgentChoice::Named("claude".into()));
        recent.record(Path::new("/other"), &AgentChoice::Named("gemini".into()));
        recent.record(
            repo,
            &AgentChoice::Command(vec!["my-agent".into(), "--acp".into()]),
        );
        assert_eq!(
            recent.last_in(repo),
            Some(AgentChoice::Command(vec![
                "my-agent".into(),
                "--acp".into()
            ]))
        );
        assert_eq!(
            recent.last_in(Path::new("/other")),
            Some(AgentChoice::Named("gemini".into()))
        );
    }

    #[test]
    fn an_unreadable_record_is_an_empty_one() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("recent.json");
        std::fs::write(&path, "not json").expect("write");
        let recent = Recent::at(path);
        assert_eq!(recent.last_in(Path::new("/repo")), None);
        recent.record(Path::new("/repo"), &AgentChoice::Named("codex".into()));
        assert_eq!(
            recent.last_in(Path::new("/repo")),
            Some(AgentChoice::Named("codex".into()))
        );
    }
}
