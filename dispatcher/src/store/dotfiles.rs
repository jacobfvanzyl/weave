//! Dotfiles configuration and per-Host sync state (ADR 0037, WVE-243), kept in migration 18's
//! `dotfiles_settings` and `dotfiles_hosts` tables.

use std::collections::HashMap;

use rusqlite::OptionalExtension as _;
use rusqlite::params;
use weave_host_protocol::Timestamp;
use weave_host_protocol::dispatcher::DEFAULT_DOTFILES_POLL_SECS;
use weave_host_protocol::dispatcher::DotfilesSettings;
use weave_host_protocol::dotfiles::DotfilesActiveMode;
use weave_host_protocol::dotfiles::DotfilesConflict;
use weave_host_protocol::dotfiles::DotfilesHostReport;
use weave_host_protocol::dotfiles::DotfilesMode;

use super::Store;
use super::failed;

fn time_to(ms: Timestamp) -> i64 {
    i64::try_from(ms).unwrap_or(i64::MAX)
}

fn time_from(ms: i64) -> Timestamp {
    u64::try_from(ms).unwrap_or(0)
}

/// Stored per-Host dotfiles mode override and last sync outcome.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct StoredDotfilesHost {
    pub(crate) mode: DotfilesMode,
    pub(crate) active_mode: Option<DotfilesActiveMode>,
    pub(crate) commit: Option<String>,
    pub(crate) local_path: Option<String>,
    pub(crate) dirty: bool,
    pub(crate) ahead: Option<u32>,
    pub(crate) linked: u32,
    pub(crate) removed: u32,
    pub(crate) conflicts: Vec<DotfilesConflict>,
    pub(crate) synced_at: Option<Timestamp>,
    pub(crate) error: Option<String>,
}

impl Store {
    /// Current dotfiles settings, or defaults when none are configured.
    pub(crate) fn dotfiles_settings(&self) -> Result<DotfilesSettings, String> {
        let row = self
            .lock()
            .query_row(
                "SELECT repo, remote, branch, git_credential, poll_interval_secs, \
                        commit_sha, fetched_at, fetch_error \
                 FROM dotfiles_settings WHERE id = 1",
                [],
                |row| {
                    let poll: i64 = row.get(4)?;
                    let fetched_at: Option<i64> = row.get(6)?;
                    Ok(DotfilesSettings {
                        repo: row.get(0)?,
                        remote: row.get(1)?,
                        branch: row.get(2)?,
                        git_credential: row.get(3)?,
                        poll_interval_secs: u64::try_from(poll)
                            .unwrap_or(DEFAULT_DOTFILES_POLL_SECS),
                        commit: row.get(5)?,
                        fetched_at: fetched_at.map(time_from),
                        fetch_error: row.get(7)?,
                    })
                },
            )
            .optional()
            .map_err(failed)?;
        Ok(row.unwrap_or_default())
    }

    /// Save dotfiles source settings. If `repo` or `branch` changed, clears `commit_sha` and
    /// `fetched_at` so the next fetch pulls the new source.
    pub(crate) fn save_dotfiles_settings(
        &self,
        repo: &str,
        remote: Option<&str>,
        branch: &str,
        git_credential: Option<&str>,
        poll_interval_secs: u64,
    ) -> Result<DotfilesSettings, String> {
        let current = self.dotfiles_settings()?;
        let changed_source = current.repo.as_deref() != Some(repo) || current.branch != branch;
        let commit = if changed_source { None } else { current.commit };
        let fetched_at = if changed_source {
            None
        } else {
            current.fetched_at
        };
        let poll = i64::try_from(poll_interval_secs).unwrap_or(i64::MAX);
        self.lock()
            .execute(
                "INSERT INTO dotfiles_settings \
                     (id, repo, remote, branch, git_credential, poll_interval_secs, \
                      commit_sha, fetched_at, fetch_error) \
                 VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6, ?7, NULL) \
                 ON CONFLICT (id) DO UPDATE SET \
                     repo = excluded.repo, \
                     remote = excluded.remote, \
                     branch = excluded.branch, \
                     git_credential = excluded.git_credential, \
                     poll_interval_secs = excluded.poll_interval_secs, \
                     commit_sha = excluded.commit_sha, \
                     fetched_at = excluded.fetched_at, \
                     fetch_error = NULL",
                params![
                    repo,
                    remote,
                    branch,
                    git_credential,
                    poll,
                    commit,
                    fetched_at.map(time_to),
                ],
            )
            .map_err(failed)?;
        self.dotfiles_settings()
    }

    /// Clear dotfiles source settings (keeps per-Host mode rows until cleared or removed).
    pub(crate) fn clear_dotfiles_settings(&self) -> Result<(), String> {
        self.lock()
            .execute("DELETE FROM dotfiles_settings WHERE id = 1", [])
            .map_err(failed)?;
        Ok(())
    }

    /// Record a successful git fetch for the currently configured `repo` and `branch`.
    pub(crate) fn record_dotfiles_fetch(
        &self,
        commit: &str,
        fetched_at: Timestamp,
    ) -> Result<(), String> {
        self.lock()
            .execute(
                "UPDATE dotfiles_settings \
                 SET commit_sha = ?1, fetched_at = ?2, fetch_error = NULL \
                 WHERE id = 1",
                params![commit, time_to(fetched_at)],
            )
            .map_err(failed)?;
        Ok(())
    }

    /// Record why the latest fetch failed, leaving any previously cached commit intact.
    pub(crate) fn record_dotfiles_fetch_error(&self, error: &str) -> Result<(), String> {
        self.lock()
            .execute(
                "UPDATE dotfiles_settings SET fetch_error = ?1 WHERE id = 1",
                params![error],
            )
            .map_err(failed)?;
        Ok(())
    }

    /// All stored per-Host dotfiles rows, keyed by `host_id`.
    pub(crate) fn dotfiles_hosts(&self) -> Result<HashMap<String, StoredDotfilesHost>, String> {
        let conn = self.lock();
        let mut stmt = conn
            .prepare(
                "SELECT host_id, mode, active_mode, commit_sha, local_path, dirty, ahead, \
                        linked, removed, conflicts, synced_at, error \
                 FROM dotfiles_hosts",
            )
            .map_err(failed)?;
        let rows = stmt
            .query_map([], |row| {
                let host_id: String = row.get(0)?;
                let mode_str: String = row.get(1)?;
                let active_str: Option<String> = row.get(2)?;
                let commit: Option<String> = row.get(3)?;
                let local_path: Option<String> = row.get(4)?;
                let dirty: i64 = row.get(5)?;
                let ahead: Option<i64> = row.get(6)?;
                let linked: i64 = row.get(7)?;
                let removed: i64 = row.get(8)?;
                let conflicts_json: String = row.get(9)?;
                let synced_at: Option<i64> = row.get(10)?;
                let error: Option<String> = row.get(11)?;
                let conflicts: Vec<DotfilesConflict> =
                    serde_json::from_str(&conflicts_json).unwrap_or_default();
                Ok((
                    host_id,
                    StoredDotfilesHost {
                        mode: DotfilesMode::parse(&mode_str).unwrap_or_default(),
                        active_mode: active_str.as_deref().and_then(DotfilesActiveMode::parse),
                        commit,
                        local_path,
                        dirty: dirty != 0,
                        ahead: ahead.and_then(|v| u32::try_from(v).ok()),
                        linked: u32::try_from(linked).unwrap_or(0),
                        removed: u32::try_from(removed).unwrap_or(0),
                        conflicts,
                        synced_at: synced_at.map(time_from),
                        error,
                    },
                ))
            })
            .map_err(failed)?;
        let mut out = HashMap::new();
        for row in rows {
            let (id, state) = row.map_err(failed)?;
            out.insert(id, state);
        }
        Ok(out)
    }

    /// Configured mode for `host_id` (`Auto` when unset).
    pub(crate) fn dotfiles_host_mode(&self, host_id: &str) -> Result<DotfilesMode, String> {
        let mode: Option<String> = self
            .lock()
            .query_row(
                "SELECT mode FROM dotfiles_hosts WHERE host_id = ?1",
                params![host_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(failed)?;
        Ok(mode
            .as_deref()
            .and_then(DotfilesMode::parse)
            .unwrap_or_default())
    }

    /// Set the configured mode override for `host_id`.
    pub(crate) fn set_dotfiles_host_mode(
        &self,
        host_id: &str,
        mode: DotfilesMode,
    ) -> Result<(), String> {
        self.lock()
            .execute(
                "INSERT INTO dotfiles_hosts (host_id, mode) VALUES (?1, ?2) \
                 ON CONFLICT (host_id) DO UPDATE SET mode = excluded.mode",
                params![host_id, mode.as_str()],
            )
            .map_err(failed)?;
        Ok(())
    }

    /// Record a successful sync report from `host_id`.
    pub(crate) fn record_dotfiles_host_report(
        &self,
        host_id: &str,
        report: &DotfilesHostReport,
        synced_at: Timestamp,
    ) -> Result<(), String> {
        let conflicts = serde_json::to_string(&report.conflicts).unwrap_or_else(|_| "[]".into());
        self.lock()
            .execute(
                "INSERT INTO dotfiles_hosts \
                     (host_id, active_mode, commit_sha, local_path, dirty, ahead, \
                      linked, removed, conflicts, synced_at, error) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, NULL) \
                 ON CONFLICT (host_id) DO UPDATE SET \
                     active_mode = excluded.active_mode, \
                     commit_sha = excluded.commit_sha, \
                     local_path = excluded.local_path, \
                     dirty = excluded.dirty, \
                     ahead = excluded.ahead, \
                     linked = excluded.linked, \
                     removed = excluded.removed, \
                     conflicts = excluded.conflicts, \
                     synced_at = excluded.synced_at, \
                     error = NULL",
                params![
                    host_id,
                    report.mode.as_str(),
                    report.commit,
                    report.local_path,
                    i64::from(report.dirty),
                    report.ahead.map(i64::from),
                    i64::from(report.linked),
                    i64::from(report.removed),
                    conflicts,
                    time_to(synced_at),
                ],
            )
            .map_err(failed)?;
        Ok(())
    }

    /// Record why syncing to `host_id` failed.
    pub(crate) fn record_dotfiles_host_error(
        &self,
        host_id: &str,
        error: &str,
    ) -> Result<(), String> {
        self.lock()
            .execute(
                "INSERT INTO dotfiles_hosts (host_id, error) VALUES (?1, ?2) \
                 ON CONFLICT (host_id) DO UPDATE SET error = excluded.error",
                params![host_id, error],
            )
            .map_err(failed)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use pretty_assertions::assert_eq;

    use super::*;

    #[test]
    fn dotfiles_settings_and_host_state_round_trip() {
        let store = Store::in_memory();
        assert_eq!(
            store.dotfiles_settings().expect("default"),
            DotfilesSettings::default()
        );
        let saved = store
            .save_dotfiles_settings(
                "https://github.com/jacobfvanzyl/.dotfiles.git",
                Some("github.com/jacobfvanzyl/.dotfiles"),
                "main",
                None,
                60,
            )
            .expect("save");
        assert_eq!(
            saved.repo.as_deref(),
            Some("https://github.com/jacobfvanzyl/.dotfiles.git")
        );
        assert_eq!(
            saved.remote.as_deref(),
            Some("github.com/jacobfvanzyl/.dotfiles")
        );
        assert_eq!(saved.branch, "main");
        assert_eq!(saved.poll_interval_secs, 60);

        store
            .record_dotfiles_fetch("abc123", 1000)
            .expect("record fetch");
        let after = store.dotfiles_settings().expect("after");
        assert_eq!(after.commit.as_deref(), Some("abc123"));
        assert_eq!(after.fetched_at, Some(1000));

        // Changing poll interval keeps the cached commit.
        let same_source = store
            .save_dotfiles_settings(
                "https://github.com/jacobfvanzyl/.dotfiles.git",
                Some("github.com/jacobfvanzyl/.dotfiles"),
                "main",
                None,
                120,
            )
            .expect("same source");
        assert_eq!(same_source.commit.as_deref(), Some("abc123"));
        assert_eq!(same_source.poll_interval_secs, 120);

        // Changing branch resets commit.
        let other_branch = store
            .save_dotfiles_settings(
                "https://github.com/jacobfvanzyl/.dotfiles.git",
                Some("github.com/jacobfvanzyl/.dotfiles"),
                "dev",
                None,
                120,
            )
            .expect("other branch");
        assert_eq!(other_branch.commit, None);

        store.clear_dotfiles_settings().expect("clear");
        assert_eq!(
            store.dotfiles_settings().expect("cleared"),
            DotfilesSettings::default()
        );
    }
}
