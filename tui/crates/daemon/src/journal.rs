//! Each session's journal: the numbered record of what its attached clients are sent, so a
//! client catches up from the last position it saw, and a restarted Host can take the
//! session up again.
//!
//! On disk it is JSONL, one [`Record`] per line, readable only by the user since it holds
//! prompts and agent output. The agent's environment is never written. The first line is the
//! header, at position 0; events follow at 1, 2, 3 and so on, each position being its line.
//! A journal ends with [`Entry::Closed`] once its session is closed; one that doesn't end that
//! way belonged to a Host that stopped, and can be recovered.

use std::collections::HashMap;
use std::collections::HashSet;
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
use weave_acp_core::schema::ContentBlock;
use weave_acp_core::schema::PromptResponse;
use weave_acp_core::schema::SessionId;
use weave_acp_core::schema::SessionNotification;
use weave_acp_core::schema::StopReason;
use weave_acp_core::schema::TerminalExitStatus;
use weave_acp_core::schema::TerminalId;
use weave_host_protocol::events::SessionEvent;
use weave_host_protocol::policy::PermissionPolicy;
use weave_host_protocol::sessions::TurnOrigin;

const VERSION: u32 = 1;

/// How the agent was chosen, as journals record it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RecordedChoice {
    /// By id.
    Named(String),
    /// A custom command, in journals from before agents were named only by id.
    Command(Vec<String>),
}

/// One line of a journal.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub(crate) struct Record {
    #[serde(flatten)]
    pub(crate) entry: Entry,
    /// When it was written; absent in journals from before records were timed.
    #[serde(default, skip_serializing_if = "is_zero")]
    pub(crate) at: u64,
}

// Serde hands `skip_serializing_if` a reference.
#[allow(clippy::trivially_copy_pass_by_ref)]
fn is_zero(value: &u64) -> bool {
    *value == 0
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub(crate) enum Entry {
    /// Always first: what the session is, so it can be launched again.
    #[serde(rename_all = "camelCase")]
    Header {
        version: u32,
        session_id: SessionId,
        agent: AgentSpec,
        /// How the agent was chosen; absent in journals from before it was recorded.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        choice: Option<RecordedChoice>,
        cwd: PathBuf,
        policy: PermissionPolicy,
        created_ms: u64,
    },
    /// A `session/update`, as clients were sent it.
    Update {
        notification: Box<SessionNotification>,
    },
    /// Output from a command the Host runs for the agent.
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
    /// A turn started. Journals from before prompts were kept here recorded them as
    /// `user_message_chunk` updates just before, and no origin.
    #[serde(rename_all = "camelCase")]
    TurnStarted {
        session_id: SessionId,
        at_ms: u64,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        prompt: Vec<ContentBlock>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        origin: Option<TurnOrigin>,
    },
    /// A turn ended: the agent's answer, or why it failed. Journals from before answers were
    /// kept recorded only the stop reason.
    #[serde(rename_all = "camelCase")]
    TurnEnded {
        session_id: SessionId,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        response: Option<PromptResponse>,
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
        agent_id: &str,
        cwd: PathBuf,
        policy: PermissionPolicy,
    ) -> Self {
        Self::Header {
            version: VERSION,
            session_id,
            agent,
            choice: Some(RecordedChoice::Named(agent_id.to_owned())),
            cwd,
            policy,
            created_ms: now_ms(),
        }
    }

    pub(crate) fn turn_ended(
        session_id: SessionId,
        result: &Result<PromptResponse, Error>,
    ) -> Self {
        let (response, error) = match result {
            Ok(response) => (Some(response.clone()), None),
            Err(error) => (None, Some(error.clone())),
        };
        Self::TurnEnded {
            session_id,
            response,
            stop_reason: None,
            error,
        }
    }

    /// The entry as clients are sent it; none for the header.
    pub(crate) fn event(&self) -> Option<SessionEvent> {
        Some(match self {
            Self::Header { .. } => return None,
            Self::Update { notification } => SessionEvent::Update {
                notification: notification.clone(),
            },
            Self::TerminalOutput { terminal_id, data } => SessionEvent::TerminalOutput {
                terminal_id: terminal_id.clone(),
                data: data.clone(),
            },
            Self::TerminalExit {
                terminal_id,
                status,
            } => SessionEvent::TerminalExit {
                terminal_id: terminal_id.clone(),
                status: status.clone(),
            },
            Self::TurnStarted {
                session_id,
                prompt,
                origin,
                ..
            } => SessionEvent::TurnStarted {
                session_id: session_id.clone(),
                prompt: prompt.clone(),
                origin: origin.clone().unwrap_or(TurnOrigin::Run {}),
            },
            Self::TurnEnded {
                session_id,
                response,
                stop_reason,
                error,
            } => SessionEvent::TurnEnded {
                session_id: session_id.clone(),
                response: response
                    .clone()
                    .or_else(|| stop_reason.map(PromptResponse::new)),
                error: error.clone(),
            },
            Self::Closed { reason, .. } => SessionEvent::Closed {
                reason: reason.clone(),
            },
        })
    }
}

pub(crate) struct Journal {
    records: Vec<Record>,
    /// Where records are appended, unless the journal only lives in memory.
    file: Option<File>,
    /// The file's path, unless the journal only lives in memory.
    path: Option<PathBuf>,
}

impl Journal {
    /// A journal that is never written down, for a Host inside one client.
    pub(crate) fn memory(header: Entry) -> Self {
        let mut journal = Self {
            records: Vec::new(),
            file: None,
            path: None,
        };
        journal.append(header);
        journal
    }

    /// A new journal for a session in `dir`, replacing any earlier one of the same session.
    pub(crate) fn create(dir: &Path, session_id: &SessionId, header: Entry) -> io::Result<Self> {
        create_private_dir(dir)?;
        let path = path_for(dir, session_id);
        let file = private_file(&path, true)?;
        let mut journal = Self {
            records: Vec::new(),
            file: Some(file),
            path: Some(path),
        };
        journal.append(header);
        Ok(journal)
    }

    /// Continue the journal at `path`, already read as `records`.
    pub(crate) fn reopen(path: &Path, records: Vec<Record>) -> io::Result<Self> {
        Ok(Self {
            records,
            file: Some(private_file(path, false)?),
            path: Some(path.to_path_buf()),
        })
    }

    /// Remove the journal from disk: its session has nothing worth keeping.
    pub(crate) fn discard(&mut self) {
        self.file = None;
        if let Some(path) = self.path.take()
            && let Err(error) = std::fs::remove_file(&path)
        {
            tracing::warn!(%error, path = %path.display(), "couldn't remove a journal");
        }
    }

    /// Append `entry`; returns its position and when it was written.
    pub(crate) fn append(&mut self, entry: Entry) -> (u64, u64) {
        let record = Record {
            entry,
            at: now_ms(),
        };
        if let Some(file) = &mut self.file {
            let written = serde_json::to_string(&record)
                .map_err(io::Error::other)
                .and_then(|line| writeln!(file, "{line}"));
            if let Err(error) = written {
                // The session carries on; only a later recovery loses what follows.
                tracing::warn!(%error, "journal write failed; keeping the rest in memory");
                self.file = None;
            }
        }
        let at = record.at;
        self.records.push(record);
        (self.head(), at)
    }

    pub(crate) fn records(&self) -> &[Record] {
        &self.records
    }

    /// The position of the last record; 0 when there's only the header.
    pub(crate) fn head(&self) -> u64 {
        u64::try_from(self.records.len().saturating_sub(1)).unwrap_or(u64::MAX)
    }

    /// The journal's id: when its header was written. A session opened again after it closed
    /// gets a new journal, and with it a new id.
    pub(crate) fn id(&self) -> String {
        match self.records.first().map(|record| &record.entry) {
            Some(Entry::Header { created_ms, .. }) => created_ms.to_string(),
            _ => "0".to_owned(),
        }
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

/// A journal's records. A line the Host was still writing when it stopped is skipped, and so
/// are records whose time is missing given the one before.
pub(crate) fn read(path: &Path) -> io::Result<Vec<Record>> {
    let file = File::open(path)?;
    let mut records: Vec<Record> = Vec::new();
    for line in io::BufReader::new(file).lines() {
        let line = line?;
        match serde_json::from_str::<Record>(&line) {
            Ok(mut record) => {
                if record.at == 0 {
                    record.at = match (&record.entry, records.last()) {
                        (Entry::Header { created_ms, .. }, _) => *created_ms,
                        (_, Some(previous)) => previous.at,
                        (_, None) => 0,
                    };
                }
                records.push(record);
            }
            Err(error) => tracing::warn!(%error, path = %path.display(), "skipping a journal line"),
        }
    }
    Ok(records)
}

/// What a journal says about its session: which agent, where, under which policy, and
/// whether it was closed or left open by a Host that stopped.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Recorded {
    pub agent: AgentSpec,
    pub choice: Option<RecordedChoice>,
    pub cwd: PathBuf,
    pub policy: PermissionPolicy,
    pub closed: bool,
    /// When it was last written to.
    pub last_activity_ms: u64,
}

impl Recorded {
    /// The agent it runs with, by id, when the journal names one.
    pub fn agent_id(&self) -> Option<&str> {
        match &self.choice {
            Some(RecordedChoice::Named(id)) => Some(id),
            _ => None,
        }
    }
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

/// A journal's header and whether its last record closed it, without reading the rest.
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
    } = serde_json::from_str::<Record>(&header).ok()?.entry
    else {
        return None;
    };
    let closed = last
        .and_then(|line| serde_json::from_str::<Record>(&line).ok())
        .is_some_and(|record| matches!(record.entry, Entry::Closed { .. }));
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

/// Whether the session the journal records was closed, rather than left by a Host that
/// stopped.
pub(crate) fn is_closed(records: &[Record]) -> bool {
    matches!(
        records.last().map(|record| &record.entry),
        Some(Entry::Closed { .. })
    )
}

/// Sessions whose turn started and never ended.
pub(crate) fn open_turns(records: &[Record]) -> Vec<SessionId> {
    let mut open: Vec<SessionId> = Vec::new();
    for record in records {
        match &record.entry {
            Entry::TurnStarted { session_id, .. } => open.push(session_id.clone()),
            Entry::TurnEnded { session_id, .. } => open.retain(|open| open != session_id),
            _ => {}
        }
    }
    open
}

/// Remove journals untouched for `age`: closed sessions, and ones left by a Host that
/// stopped and never taken up again. The `live` sessions' journals stay, however quiet.
pub(crate) fn prune(dir: &Path, age: Duration, live: &[SessionId]) {
    let Ok(listing) = std::fs::read_dir(dir) else {
        return;
    };
    let cutoff = SystemTime::now().checked_sub(age).unwrap_or(UNIX_EPOCH);
    let live: HashSet<PathBuf> = live
        .iter()
        .map(|session_id| path_for(dir, session_id))
        .collect();
    for entry in listing.flatten() {
        let path = entry.path();
        let stale = path
            .extension()
            .is_some_and(|extension| extension == "jsonl")
            && !live.contains(&path)
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
            "agent",
            "/repo".into(),
            PermissionPolicy::ask(),
        )
    }

    #[test]
    fn a_journal_reads_back_what_was_appended() {
        let dir = tempfile::tempdir().expect("tempdir");
        let id = SessionId::new("s/1");
        let mut journal = Journal::create(dir.path(), &id, header("s/1")).expect("create");
        assert_eq!(journal.head(), 0);
        let (seq, _) = journal.append(Entry::TurnStarted {
            session_id: id.clone(),
            at_ms: 1,
            prompt: vec![ContentBlock::from("hi".to_owned())],
            origin: None,
        });
        assert_eq!(seq, 1);
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
        let records = read(&path).expect("read");
        assert_eq!(records.len(), 3);
        assert!(!is_closed(&records));
        assert_eq!(open_turns(&records), std::slice::from_ref(&id));

        // Reopened after a restart, it carries on where it was, under the same id.
        let id_before = journal.id();
        let mut journal = Journal::reopen(&path, records).expect("reopen");
        assert_eq!(journal.id(), id_before);
        journal.append(Entry::turn_ended(
            id,
            &Ok(PromptResponse::new(StopReason::Cancelled)),
        ));
        let (seq, _) = journal.append(Entry::Closed {
            reason: "closed".into(),
            at_ms: 2,
        });
        assert_eq!(seq, 4);
        let records = read(&path).expect("read");
        assert!(open_turns(&records).is_empty());
        assert!(is_closed(&records));
        // Its record, alone and in the index.
        let recorded = recorded(dir.path(), &SessionId::new("s/1")).expect("recorded");
        assert_eq!(recorded.agent_id(), Some("agent"));
        assert_eq!(recorded.cwd, PathBuf::from("/repo"));
        assert!(recorded.closed);
        let index = index(dir.path());
        assert_eq!(index.get(&SessionId::new("s/1")), Some(&recorded));
    }

    /// Journals from before records were timed, prompts kept with their turn, and answers
    /// kept whole still read, and replay as clients expect.
    #[test]
    fn journals_written_before_this_format_still_read() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("old.jsonl");
        let lines = [
            r#"{"type":"header","version":1,"sessionId":"old","agent":{"command":"npx","args":["x"]},"choice":{"command":["my-agent"]},"cwd":"/repo","policy":{},"createdMs":5}"#,
            r#"{"type":"update","notification":{"sessionId":"old","update":{"sessionUpdate":"user_message_chunk","content":{"type":"text","text":"hi"}}}}"#,
            r#"{"type":"turnStarted","sessionId":"old","atMs":6}"#,
            r#"{"type":"turnEnded","sessionId":"old","stopReason":"end_turn"}"#,
        ];
        std::fs::write(&path, lines.join("\n")).expect("old journal");
        let records = read(&path).expect("read");
        assert_eq!(records.len(), 4);
        assert!(records.iter().all(|record| record.at == 5));
        assert!(matches!(
            records[3].entry.event(),
            Some(SessionEvent::TurnEnded { response: Some(response), .. })
                if response.stop_reason == StopReason::EndTurn
        ));
        let (_, recorded) = record_of(&path).expect("recorded");
        assert_eq!(recorded.agent_id(), None);
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

    #[test]
    fn pruning_removes_old_journals_but_not_live_sessions() {
        let dir = tempfile::tempdir().expect("tempdir");
        let retention = Duration::from_secs(14 * 24 * 60 * 60);
        let long_ago = SystemTime::now() - retention * 2;
        for id in ["live", "stale", "recent"] {
            Journal::create(dir.path(), &id.into(), header(id)).expect("create");
        }
        for id in ["live", "stale"] {
            File::options()
                .write(true)
                .open(path_for(dir.path(), &id.into()))
                .and_then(|file| file.set_modified(long_ago))
                .expect("backdate");
        }
        prune(dir.path(), retention, &["live".into()]);
        let kept = |id: &str| path_for(dir.path(), &SessionId::new(id.to_owned())).exists();
        assert!(kept("live"));
        assert!(!kept("stale"));
        assert!(kept("recent"));
    }

    #[test]
    fn a_discarded_journal_leaves_nothing_behind() {
        let dir = tempfile::tempdir().expect("tempdir");
        let mut journal = Journal::create(dir.path(), &"s1".into(), header("s1")).expect("create");
        journal.discard();
        assert!(!path_for(dir.path(), &"s1".into()).exists());
        // Anything appended later stays in memory.
        journal.append(Entry::Closed {
            reason: "closed".into(),
            at_ms: 1,
        });
        assert!(!path_for(dir.path(), &"s1".into()).exists());
    }
}
