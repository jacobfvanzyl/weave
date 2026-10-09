//! Each live session's journal: what its clients were sent, so a client that attaches later
//! sees the same transcript, and a restarted daemon can take the session up again.
//!
//! On disk it is JSONL, one [`Entry`] per line, readable only by the user since it holds
//! prompts and agent output. The client environment a session was launched with is never
//! written. A journal ends with [`Entry::Closed`] once its session is closed; one that
//! doesn't end that way belonged to a daemon that stopped, and can be recovered.

use std::collections::HashMap;
use std::fs::File;
use std::fs::OpenOptions;
use std::io;
use std::io::BufRead;
use std::io::Write;
use std::path::Path;
use std::path::PathBuf;
use std::time::Duration;
use std::time::SystemTime;
use std::time::UNIX_EPOCH;

use agent_client_protocol::Error;
use serde::Deserialize;
use serde::Serialize;
use weave_acp_core::AgentSpec;
use weave_acp_core::daemon_protocol::AgentChoice;
use weave_acp_core::daemon_protocol::PermissionPolicy;
use weave_acp_core::schema::SessionId;
use weave_acp_core::schema::SessionNotification;
use weave_acp_core::schema::StopReason;
use weave_acp_core::schema::TerminalExitStatus;
use weave_acp_core::schema::TerminalId;

const VERSION: u32 = 1;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub(crate) enum Entry {
    /// Always first: what the session is, so it can be launched again.
    #[serde(rename_all = "camelCase")]
    Header {
        version: u32,
        session_id: SessionId,
        agent: AgentSpec,
        /// How the user chose the agent; absent in journals from before it was recorded.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        choice: Option<AgentChoice>,
        cwd: PathBuf,
        policy: PermissionPolicy,
        created_ms: u64,
    },
    /// A `session/update`, as clients were sent it.
    Update {
        notification: Box<SessionNotification>,
    },
    /// Output from a command the daemon runs for the agent.
    #[serde(rename_all = "camelCase")]
    TerminalOutput {
        terminal_id: TerminalId,
        data: String,
    },
    #[serde(rename_all = "camelCase")]
    TerminalExit {
        terminal_id: TerminalId,
        status: TerminalExitStatus,
    },
    #[serde(rename_all = "camelCase")]
    TurnStarted { session_id: SessionId, at_ms: u64 },
    #[serde(rename_all = "camelCase")]
    TurnEnded {
        session_id: SessionId,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        stop_reason: Option<StopReason>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        error: Option<Error>,
    },
    #[serde(rename_all = "camelCase")]
    Closed { reason: String, at_ms: u64 },
}

impl Entry {
    pub(crate) fn header(
        session_id: SessionId,
        agent: AgentSpec,
        choice: Option<AgentChoice>,
        cwd: PathBuf,
        policy: PermissionPolicy,
    ) -> Self {
        Self::Header {
            version: VERSION,
            session_id,
            agent,
            choice,
            cwd,
            policy,
            created_ms: now_ms(),
        }
    }
}

pub(crate) struct Journal {
    entries: Vec<Entry>,
    /// Where entries are appended, unless the journal only lives in memory.
    file: Option<File>,
}

impl Journal {
    /// A journal that is never written down, for a daemon inside one client.
    pub(crate) fn memory(header: Entry) -> Self {
        Self {
            entries: vec![header],
            file: None,
        }
    }

    /// A new journal for a session in `dir`, replacing any earlier one of the same session.
    pub(crate) fn create(dir: &Path, session_id: &SessionId, header: Entry) -> io::Result<Self> {
        create_private_dir(dir)?;
        let file = private_file(&path_for(dir, session_id), true)?;
        let mut journal = Self {
            entries: Vec::new(),
            file: Some(file),
        };
        journal.append(header);
        Ok(journal)
    }

    /// Continue the journal at `path`, already read as `entries`.
    pub(crate) fn reopen(path: &Path, entries: Vec<Entry>) -> io::Result<Self> {
        Ok(Self {
            entries,
            file: Some(private_file(path, false)?),
        })
    }

    pub(crate) fn append(&mut self, entry: Entry) {
        if let Some(file) = &mut self.file {
            let written = serde_json::to_string(&entry)
                .map_err(io::Error::other)
                .and_then(|line| writeln!(file, "{line}"));
            if let Err(error) = written {
                // The session carries on; only a later recovery loses what follows.
                tracing::warn!(%error, "journal write failed; keeping the rest in memory");
                self.file = None;
            }
        }
        self.entries.push(entry);
    }

    pub(crate) fn entries(&self) -> &[Entry] {
        &self.entries
    }
}

/// The journal file for `session_id`: its id, with anything unsafe in a file name escaped.
pub(crate) fn path_for(dir: &Path, session_id: &SessionId) -> PathBuf {
    let mut name = String::new();
    for byte in session_id.to_string().bytes() {
        match byte {
            b'a'..=b'z' | b'A'..=b'Z' | b'0'..=b'9' | b'-' | b'_' => name.push(char::from(byte)),
            other => name.push_str(&format!("~{other:02x}")),
        }
    }
    dir.join(format!("{name}.jsonl"))
}

/// A journal's entries. A line the daemon was still writing when it stopped is skipped.
pub(crate) fn read(path: &Path) -> io::Result<Vec<Entry>> {
    let file = File::open(path)?;
    let mut entries = Vec::new();
    for line in io::BufReader::new(file).lines() {
        let line = line?;
        match serde_json::from_str(&line) {
            Ok(entry) => entries.push(entry),
            Err(error) => tracing::warn!(%error, path = %path.display(), "skipping a journal line"),
        }
    }
    Ok(entries)
}

/// What a journal says about its session: which agent, where, under which policy, and
/// whether it was closed or left open by a daemon that stopped.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Recorded {
    pub agent: AgentSpec,
    pub choice: Option<AgentChoice>,
    pub cwd: PathBuf,
    pub policy: PermissionPolicy,
    pub closed: bool,
    /// When it was last written to.
    pub last_activity_ms: u64,
}

/// The record of `session_id`'s journal in `dir`, if it has one.
pub(crate) fn recorded(dir: &Path, session_id: &SessionId) -> Option<Recorded> {
    record_of(&path_for(dir, session_id)).map(|(_, recorded)| recorded)
}

/// Every journal's record in `dir`, by session.
pub(crate) fn index(dir: &Path) -> HashMap<SessionId, Recorded> {
    let Ok(listing) = std::fs::read_dir(dir) else {
        return HashMap::new();
    };
    listing
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| {
            path.extension()
                .is_some_and(|extension| extension == "jsonl")
        })
        .filter_map(|path| record_of(&path))
        .collect()
}

/// A journal's header and whether its last entry closed it, without reading the rest.
fn record_of(path: &Path) -> Option<(SessionId, Recorded)> {
    let file = File::open(path).ok()?;
    let modified = file
        .metadata()
        .and_then(|metadata| metadata.modified())
        .ok()
        .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |elapsed| {
            u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX)
        });
    let mut lines = io::BufReader::new(file).lines().map_while(Result::ok);
    let header = lines.next()?;
    let last = lines.last();
    let Entry::Header {
        session_id,
        agent,
        choice,
        cwd,
        policy,
        ..
    } = serde_json::from_str(&header).ok()?
    else {
        return None;
    };
    let closed = last
        .and_then(|line| serde_json::from_str::<Entry>(&line).ok())
        .is_some_and(|entry| matches!(entry, Entry::Closed { .. }));
    Some((
        session_id,
        Recorded {
            agent,
            choice,
            cwd,
            policy,
            closed,
            last_activity_ms: modified,
        },
    ))
}

/// Whether the session the journal records was closed, rather than left by a daemon that
/// stopped.
pub(crate) fn is_closed(entries: &[Entry]) -> bool {
    matches!(entries.last(), Some(Entry::Closed { .. }))
}

/// Sessions whose turn started and never ended.
pub(crate) fn open_turns(entries: &[Entry]) -> Vec<SessionId> {
    let mut open: Vec<SessionId> = Vec::new();
    for entry in entries {
        match entry {
            Entry::TurnStarted { session_id, .. } => open.push(session_id.clone()),
            Entry::TurnEnded { session_id, .. } => open.retain(|open| open != session_id),
            _ => {}
        }
    }
    open
}

/// Remove journals untouched for `age`: closed sessions, and ones left by a daemon that
/// stopped and never taken up again.
pub(crate) fn prune(dir: &Path, age: Duration) {
    let Ok(listing) = std::fs::read_dir(dir) else {
        return;
    };
    let cutoff = SystemTime::now().checked_sub(age).unwrap_or(UNIX_EPOCH);
    for entry in listing.flatten() {
        let path = entry.path();
        let stale = path
            .extension()
            .is_some_and(|extension| extension == "jsonl")
            && entry
                .metadata()
                .and_then(|metadata| metadata.modified())
                .is_ok_and(|modified| modified < cutoff);
        if stale && let Err(error) = std::fs::remove_file(&path) {
            tracing::warn!(%error, path = %path.display(), "couldn't prune a journal");
        }
    }
}

pub(crate) fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| {
            u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX)
        })
}

/// A directory only the user can read.
pub(crate) fn create_private_dir(dir: &Path) -> io::Result<()> {
    let mut builder = std::fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(dir)
}

fn private_file(path: &Path, truncate: bool) -> io::Result<File> {
    let mut options = OpenOptions::new();
    if truncate {
        options.write(true).create(true).truncate(true);
    } else {
        options.append(true);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path)
}

#[cfg(test)]
mod tests {
    use pretty_assertions::assert_eq;
    use weave_acp_core::schema::ContentChunk;
    use weave_acp_core::schema::SessionUpdate;

    use super::*;

    fn header(session_id: &str) -> Entry {
        Entry::header(
            SessionId::new(session_id.to_owned()),
            AgentSpec::new("agent", ["--acp"]),
            Some(AgentChoice::Named("agent".into())),
            "/repo".into(),
            PermissionPolicy::ask(),
        )
    }

    #[test]
    fn a_journal_reads_back_what_was_appended() {
        let dir = tempfile::tempdir().expect("tempdir");
        let id = SessionId::new("s/1");
        let mut journal = Journal::create(dir.path(), &id, header("s/1")).expect("create");
        journal.append(Entry::TurnStarted {
            session_id: id.clone(),
            at_ms: 1,
        });
        journal.append(Entry::Update {
            notification: Box::new(SessionNotification::new(
                id.clone(),
                SessionUpdate::AgentMessageChunk(ContentChunk::new("hi".into())),
            )),
        });
        let path = path_for(dir.path(), &id);
        assert_eq!(
            path.file_name().and_then(|name| name.to_str()),
            Some("s~2f1.jsonl")
        );
        let entries = read(&path).expect("read");
        assert_eq!(entries.len(), 3);
        assert!(!is_closed(&entries));
        assert_eq!(open_turns(&entries), std::slice::from_ref(&id));

        // Reopened after a restart, it carries on where it was.
        let mut journal = Journal::reopen(&path, entries).expect("reopen");
        journal.append(Entry::TurnEnded {
            session_id: id,
            stop_reason: Some(StopReason::Cancelled),
            error: None,
        });
        journal.append(Entry::Closed {
            reason: "closed".into(),
            at_ms: 2,
        });
        let entries = read(&path).expect("read");
        assert!(open_turns(&entries).is_empty());
        assert!(is_closed(&entries));
        // Its record, alone and in the index.
        let recorded = recorded(dir.path(), &SessionId::new("s/1")).expect("recorded");
        assert_eq!(recorded.choice, Some(AgentChoice::Named("agent".into())));
        assert_eq!(recorded.cwd, PathBuf::from("/repo"));
        assert!(recorded.closed);
        let index = index(dir.path());
        assert_eq!(index.get(&SessionId::new("s/1")), Some(&recorded));
    }

    #[cfg(unix)]
    #[test]
    fn journals_are_private() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().expect("tempdir");
        let sessions = dir.path().join("sessions");
        Journal::create(&sessions, &"s1".into(), header("s1")).expect("create");
        let mode = |path: &Path| {
            std::fs::metadata(path)
                .map(|metadata| metadata.permissions().mode() & 0o777)
                .unwrap_or_default()
        };
        assert_eq!(mode(&sessions), 0o700);
        assert_eq!(mode(&path_for(&sessions, &"s1".into())), 0o600);
    }
}
