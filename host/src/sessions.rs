//! Sessions and their layouts, which the Host keeps without reading them (ADR 0031, WVE-202).
//!
//! A Session is known by its directory: the deepest worktree a directory is in, or the directory
//! itself outside a repository, as a terminal's scope is. Each is kept in a file of its own in
//! the Host's `layouts` directory, named by a hash of the directory, and replaced whole when its
//! layout is set, so it survives the Host's restarts and updates. A Host with nowhere to keep
//! them, as one inside a client, keeps them in memory.
//!
//! Lock order: the Sessions' state before the registry and the terminals' state, which the
//! closures that give a Session's threads and terminals take. Nothing holding either of those
//! calls in here.

use std::collections::BTreeMap;
use std::collections::BTreeSet;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Mutex;

use agent_client_protocol::ConnectionTo;
use agent_client_protocol::Error;
use serde::Deserialize;
use serde::Serialize;
use sha2::Digest;
use sha2::Sha256;
use weave_host_protocol::HostClient;
use weave_host_protocol::errors;
use weave_host_protocol::sessions::MAX_LAYOUT;
use weave_host_protocol::sessions::Session;
use weave_host_protocol::sessions::SessionEndedNotification;
use weave_host_protocol::sessions::SessionUpdatedNotification;
use weave_host_protocol::threads::ThreadId;
use weave_host_protocol::worktrees::GitLocation;

use crate::journal::now_ms;
use crate::thread::lock;

/// What a Session holds that its record doesn't, read from the Host as it is now: its threads,
/// most recently active first, and its terminals' ids, oldest first.
pub(crate) type Contents<'a> = &'a dyn Fn(&Path) -> (Vec<ThreadId>, Vec<String>);

pub(crate) struct Sessions {
    /// Where each Session's file is; none keeps them in memory only.
    dir: Option<PathBuf>,
    state: Mutex<State>,
}

#[derive(Default)]
struct State {
    records: BTreeMap<PathBuf, Record>,
    /// Clients watching Sessions (`sessions/watch`), by connection.
    watchers: BTreeMap<u64, Watcher>,
}

struct Watcher {
    cx: ConnectionTo<HostClient>,
    /// Watching every Session.
    all: bool,
    directories: BTreeSet<PathBuf>,
}

impl Watcher {
    fn watches(&self, directory: &Path) -> bool {
        self.all || self.directories.contains(directory)
    }
}

/// A Session as its file keeps it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Record {
    directory: PathBuf,
    revision: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    layout: Option<serde_json::Value>,
    /// Where in a repository it is, as the Host last read it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    git: Option<GitLocation>,
    created_at: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    updated_at: Option<u64>,
}

impl Record {
    fn session(&self, contents: Contents<'_>, with_layout: bool) -> Session {
        let (threads, terminals) = contents(&self.directory);
        Session {
            directory: self.directory.clone(),
            revision: self.revision,
            layout: if with_layout {
                self.layout.clone()
            } else {
                None
            },
            git: self.git.clone(),
            created_at: self.created_at,
            updated_at: self.updated_at,
            threads,
            terminals,
        }
    }
}

impl Sessions {
    /// The Sessions kept in `dir`, but those whose directory is gone, which end as they're
    /// found; none keeps them in memory.
    pub(crate) fn load(dir: Option<PathBuf>) -> Self {
        let mut records: BTreeMap<PathBuf, Record> = BTreeMap::new();
        if let Some(dir) = &dir {
            for record in read_dir(dir) {
                if !record.directory.is_dir() {
                    tracing::info!(directory = %record.directory.display(), "a Session's directory is gone, so it ended");
                    remove_file(&file_for(dir, &record.directory));
                    continue;
                }
                match records.get(&record.directory) {
                    Some(kept) if kept.revision >= record.revision => {}
                    _ => {
                        records.insert(record.directory.clone(), record);
                    }
                }
            }
        }
        Self {
            dir,
            state: Mutex::new(State {
                records,
                watchers: BTreeMap::new(),
            }),
        }
    }

    /// The Sessions' directories.
    pub(crate) fn directories(&self) -> Vec<PathBuf> {
        lock(&self.state).records.keys().cloned().collect()
    }

    /// Keep where in a repository a Session is, as read again.
    pub(crate) fn located(&self, directory: &Path, git: Option<GitLocation>) {
        let mut state = lock(&self.state);
        if let Some(record) = state.records.get_mut(directory)
            && record.git != git
        {
            record.git = git;
            let record = record.clone();
            self.write(&record);
        }
    }

    /// Every Session, without its layout.
    pub(crate) fn list(&self, contents: Contents<'_>) -> Vec<Session> {
        let state = lock(&self.state);
        state
            .records
            .values()
            .map(|record| record.session(contents, false))
            .collect()
    }

    /// The Session at `directory`, with its layout.
    pub(crate) fn get(&self, directory: &Path, contents: Contents<'_>) -> Option<Session> {
        let state = lock(&self.state);
        state
            .records
            .get(directory)
            .map(|record| record.session(contents, true))
    }

    /// Make a Session at `directory` if there's none, without a layout, and tell its watchers.
    pub(crate) fn make(&self, directory: &Path, git: Option<GitLocation>, contents: Contents<'_>) {
        let mut state = lock(&self.state);
        if state.records.contains_key(directory) {
            return;
        }
        let record = Record {
            directory: directory.to_path_buf(),
            revision: 0,
            layout: None,
            git,
            created_at: now_ms(),
            updated_at: None,
        };
        self.write(&record);
        let session = record.session(contents, true);
        state.records.insert(directory.to_path_buf(), record);
        tell(
            &mut state,
            directory,
            &SessionUpdatedNotification { session },
        );
    }

    /// `sessions/set`: a new layout for the Session at `directory`, made first if there's none,
    /// under the next revision; the newest write wins. With `if_revision`, only when that's
    /// still its revision.
    pub(crate) fn set(
        &self,
        directory: &Path,
        layout: serde_json::Value,
        if_revision: Option<u64>,
        git: Option<GitLocation>,
        contents: Contents<'_>,
    ) -> Result<Session, Error> {
        let size = serde_json::to_vec(&layout)
            .map_err(|error| Error::invalid_params().data(error.to_string()))?
            .len();
        if size > MAX_LAYOUT {
            return Err(Error::invalid_params().data(format!(
                "the layout is {size} bytes, more than the {MAX_LAYOUT} a Session keeps"
            )));
        }
        let mut state = lock(&self.state);
        let now = now_ms();
        let current = state.records.get(directory);
        let revision = current.map_or(0, |record| record.revision);
        if let Some(expected) = if_revision
            && expected != revision
        {
            return Err(errors::revision_conflict(revision));
        }
        let record = Record {
            directory: directory.to_path_buf(),
            revision: revision + 1,
            layout: Some(layout),
            git,
            created_at: current.map_or(now, |record| record.created_at),
            updated_at: Some(now),
        };
        if let Err(error) = self.try_write(&record) {
            return Err(Error::internal_error()
                .data(format!("couldn't keep the Session's layout: {error}")));
        }
        let session = record.session(contents, true);
        state.records.insert(directory.to_path_buf(), record);
        tell(
            &mut state,
            directory,
            &SessionUpdatedNotification {
                session: session.clone(),
            },
        );
        Ok(session)
    }

    /// Whether there's a Session at `directory`.
    pub(crate) fn has(&self, directory: &Path) -> bool {
        lock(&self.state).records.contains_key(directory)
    }

    /// End the Session at `directory`, and tell its watchers. Whether there was one.
    pub(crate) fn end(&self, directory: &Path) -> bool {
        self.end_where(|path| path == directory)
    }

    /// End the Sessions at or inside `path`, as a worktree goes, and tell their watchers.
    pub(crate) fn end_inside(&self, path: &Path) {
        self.end_where(|directory| directory.starts_with(path));
    }

    fn end_where(&self, ends: impl Fn(&Path) -> bool) -> bool {
        let mut state = lock(&self.state);
        let ended: Vec<PathBuf> = state
            .records
            .keys()
            .filter(|path| ends(path))
            .cloned()
            .collect();
        for path in &ended {
            state.records.remove(path);
            if let Some(dir) = &self.dir {
                remove_file(&file_for(dir, path));
            }
            tell(
                &mut state,
                path,
                &SessionEndedNotification {
                    directory: path.clone(),
                },
            );
        }
        !ended.is_empty()
    }

    /// End the Sessions whose directory is gone, as when a worktree was removed without the
    /// Host.
    pub(crate) fn end_gone(&self) {
        for directory in self.directories() {
            if !directory.is_dir() {
                tracing::info!(directory = %directory.display(), "a Session's directory is gone, so it ended");
                self.end(&directory);
            }
        }
    }

    /// `sessions/watch`: `respond` with the Session at `directory`, or every Session, then tell
    /// `client` of every change to them. Nothing reaches the watcher between the two.
    pub(crate) fn watch(
        &self,
        client: u64,
        cx: ConnectionTo<HostClient>,
        directory: Option<&Path>,
        contents: Contents<'_>,
        respond: impl FnOnce(Vec<Session>) -> Result<(), Error>,
    ) -> Result<(), Error> {
        let mut state = lock(&self.state);
        let sessions = state
            .records
            .values()
            .filter(|record| directory.is_none_or(|directory| record.directory == directory))
            .map(|record| record.session(contents, true))
            .collect();
        respond(sessions)?;
        let watcher = state.watchers.entry(client).or_insert_with(|| Watcher {
            cx,
            all: false,
            directories: BTreeSet::new(),
        });
        match directory {
            Some(directory) => {
                watcher.directories.insert(directory.to_path_buf());
            }
            None => watcher.all = true,
        }
        Ok(())
    }

    pub(crate) fn unwatch(&self, client: u64, directory: Option<&Path>) {
        let mut state = lock(&self.state);
        if let Some(watcher) = state.watchers.get_mut(&client) {
            match directory {
                Some(directory) => {
                    watcher.directories.remove(directory);
                }
                None => watcher.all = false,
            }
        }
    }

    /// The client's connection ended.
    pub(crate) fn forget(&self, client: u64) {
        lock(&self.state).watchers.remove(&client);
    }

    fn write(&self, record: &Record) {
        if let Err(error) = self.try_write(record) {
            tracing::warn!(%error, directory = %record.directory.display(), "couldn't keep a Session");
        }
    }

    fn try_write(&self, record: &Record) -> std::io::Result<()> {
        let Some(dir) = &self.dir else {
            return Ok(());
        };
        crate::journal::create_private_dir(dir)?;
        crate::devices::write_private(&file_for(dir, &record.directory), record)
    }
}

/// Tell the clients watching `directory`, dropping those that have gone.
fn tell<N>(state: &mut State, directory: &Path, notification: &N)
where
    N: agent_client_protocol::JsonRpcNotification + Clone,
{
    state.watchers.retain(|_, watcher| {
        !watcher.watches(directory) || watcher.cx.send_notification(notification.clone()).is_ok()
    });
}

/// A Session's file: a hash of its directory, which may be any length and hold any character.
fn file_for(dir: &Path, directory: &Path) -> PathBuf {
    let hash = Sha256::digest(directory.as_os_str().as_encoded_bytes());
    let name: String = hash[..16]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    dir.join(format!("{name}.json"))
}

fn read_dir(dir: &Path) -> Vec<Record> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.extension().is_some_and(|extension| extension == "json"))
        .filter_map(|path| {
            let read = std::fs::read(&path)
                .map_err(|error| error.to_string())
                .and_then(|bytes| {
                    serde_json::from_slice::<Record>(&bytes).map_err(|error| error.to_string())
                });
            match read {
                Ok(record) => Some(record),
                Err(error) => {
                    tracing::warn!(%error, path = %path.display(), "couldn't read a Session; it's left alone");
                    None
                }
            }
        })
        .collect()
}

fn remove_file(path: &Path) {
    match std::fs::remove_file(path) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            tracing::warn!(%error, path = %path.display(), "couldn't remove a Session's file");
        }
    }
}

#[cfg(test)]
mod tests {
    use pretty_assertions::assert_eq;

    use super::*;

    fn nothing(_: &Path) -> (Vec<ThreadId>, Vec<String>) {
        (Vec::new(), Vec::new())
    }

    #[test]
    fn revisions_only_go_up_and_survive_a_reload() {
        let kept = tempfile::tempdir().expect("tempdir");
        let work = tempfile::tempdir().expect("tempdir");
        let directory = work.path().to_path_buf();
        let sessions = Sessions::load(Some(kept.path().to_path_buf()));
        sessions.make(&directory, None, &nothing);
        let first = sessions
            .set(
                &directory,
                serde_json::json!({"version": 1, "tabs": []}),
                Some(0),
                None,
                &nothing,
            )
            .expect("sets");
        assert_eq!(first.revision, 1);
        let stale = sessions.set(&directory, serde_json::json!({}), Some(0), None, &nothing);
        assert!(stale.is_err_and(|error| errors::is(&error, errors::REVISION_CONFLICT)));
        let second = sessions
            .set(
                &directory,
                serde_json::json!({"version": 1, "tabs": [{"id": "a"}]}),
                None,
                None,
                &nothing,
            )
            .expect("sets");
        assert_eq!(second.revision, 2);

        let reloaded = Sessions::load(Some(kept.path().to_path_buf()));
        assert_eq!(reloaded.get(&directory, &nothing), Some(second));
    }

    #[test]
    fn a_session_whose_directory_is_gone_ends_when_loaded() {
        let kept = tempfile::tempdir().expect("tempdir");
        let work = tempfile::tempdir().expect("tempdir");
        let directory = work.path().join("worktree");
        std::fs::create_dir(&directory).expect("mkdir");
        Sessions::load(Some(kept.path().to_path_buf())).make(&directory, None, &nothing);
        std::fs::remove_dir(&directory).expect("rmdir");
        let reloaded = Sessions::load(Some(kept.path().to_path_buf()));
        assert_eq!(reloaded.directories(), Vec::<PathBuf>::new());
        assert_eq!(read_dir(kept.path()), Vec::new());
    }

    #[test]
    fn a_layout_over_the_limit_is_refused() {
        let sessions = Sessions::load(None);
        let layout = serde_json::json!({"padding": "x".repeat(MAX_LAYOUT)});
        let refused = sessions.set(Path::new("/tmp"), layout, None, None, &nothing);
        assert!(refused.is_err());
        assert_eq!(sessions.directories(), Vec::<PathBuf>::new());
    }
}
