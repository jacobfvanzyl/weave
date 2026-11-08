//! Each thread's journal: the numbered record of what its attached clients are sent, so a
//! client catches up from the last position it saw, and a restarted Host can take the
//! thread up again.
//!
//! On disk it is JSONL, one [`Record`] per line, readable only by the user since it holds
//! prompts and agent output. The agent's environment is never written. The first line is the
//! header, at position 0; events follow at 1, 2, 3 and so on, each position being its line.
//! A journal ends with [`Entry::Closed`] once its thread is closed; one that doesn't end that
//! way belonged to a Host that stopped, and can be recovered.
//!
//! Every record is kept in memory as well. When writing one fails, as on a full disk, the file
//! is written again in full from memory once it can be, so no record is lost and every
//! position on disk stays the one clients were given.

use std::collections::HashMap;
use std::collections::HashSet;
use std::collections::VecDeque;
use std::ffi::OsStr;
use std::fs::File;
use std::fs::OpenOptions;
use std::io;
use std::io::BufRead;
use std::io::Write;
use std::path::Path;
use std::path::PathBuf;
use std::time::Duration;
use std::time::Instant;
use std::time::SystemTime;
use std::time::UNIX_EPOCH;

use agent_client_protocol::Error;
use serde::Deserialize;
use serde::Serialize;
use weave_acp_core::AgentSpec;
use weave_acp_core::schema::CompactionId;
use weave_acp_core::schema::CompactionStatus;
use weave_acp_core::schema::ContentBlock;
use weave_acp_core::schema::PromptResponse;
use weave_acp_core::schema::SessionConfigOption;
use weave_acp_core::schema::SessionModeState;
use weave_acp_core::schema::SessionNotification;
use weave_acp_core::schema::SessionUpdate;
use weave_acp_core::schema::StopReason;
use weave_acp_core::schema::TerminalExitStatus;
use weave_acp_core::schema::TerminalId;
use weave_host_protocol::agents::AgentRelease;
use weave_host_protocol::errors;
use weave_host_protocol::events::ThreadEvent;
use weave_host_protocol::policy::PermissionPolicy;
use weave_host_protocol::queue::QueuePause;
use weave_host_protocol::queue::QueuedId;
use weave_host_protocol::queue::QueuedPrompt;
use weave_host_protocol::threads::ContextUsage;
use weave_host_protocol::threads::LastCompaction;
use weave_host_protocol::threads::LatestTurn;
use weave_host_protocol::threads::ThreadAgent;
use weave_host_protocol::threads::ThreadId;
use weave_host_protocol::threads::TurnOrigin;
use weave_host_protocol::threads::TurnState;
use weave_host_protocol::turns::TurnId;
use weave_host_protocol::worktrees::GitLocation;

use crate::queue::Queue;

const VERSION: u32 = 1;

/// How long after a failed write a journal tries writing itself out in full again.
const RETRY_INTERVAL: Duration = Duration::from_secs(5);

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
    /// Always first: what the thread is, so it can be launched again.
    #[serde(rename_all = "camelCase")]
    Header {
        version: u32,
        #[serde(alias = "sessionId")]
        thread_id: ThreadId,
        agent: AgentSpec,
        /// How the agent was chosen; absent in journals from before it was recorded.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        choice: Option<RecordedChoice>,
        cwd: PathBuf,
        policy: PermissionPolicy,
        created_ms: u64,
        /// The title the Host kept for the thread (`thread/rename`) when this journal began,
        /// as one that replaced a closed thread's journal.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        title: Option<String>,
        /// Where in a git repository `cwd` was when this journal began; absent outside one,
        /// and in journals from before the Host looked.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        git: Option<GitLocation>,
        /// The queue a closed thread's journal left, carried on into this one.
        #[serde(
            default,
            skip_serializing_if = "Vec::is_empty",
            deserialize_with = "version_2::queue"
        )]
        queue: Vec<QueuedPrompt>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        queue_paused: Option<QueuePause>,
        /// The thread whose agent started this one, for a delegated thread; carried on into
        /// the journal a closed thread gets when it opens again.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        started_by: Option<ThreadId>,
        /// The other Host `started_by` is on, when it isn't this one.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        started_by_host: Option<String>,
        /// The thread's successor when this journal began, as one that replaced a closed
        /// thread's journal (WVE-168).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        successor: Option<ThreadId>,
        /// Its labels when this journal began: those it was started with, or a closed
        /// thread's (WVE-173).
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        labels: Vec<String>,
        /// A closed thread's context usage and last compaction, carried on (WVE-174).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        usage: Option<Box<CarriedUsage>>,
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
        #[serde(alias = "sessionId")]
        thread_id: ThreadId,
        at_ms: u64,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        prompt: Vec<ContentBlock>,
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "version_2::some_origin"
        )]
        origin: Option<TurnOrigin>,
        /// The queued prompt it started from.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        queued_id: Option<QueuedId>,
        /// The turn's id; absent from journals of Hosts that gave none, whose queued turns go
        /// by their `queued_id`.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        turn_id: Option<TurnId>,
        /// The request key it was started under, which a repeat finds it by.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        key: Option<String>,
        /// The interrupted turn it continues (WVE-144).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        continues: Option<TurnId>,
    },
    /// A message joined the running turn (`turn/steer`).
    #[serde(rename_all = "camelCase")]
    TurnSteered {
        #[serde(alias = "sessionId")]
        thread_id: ThreadId,
        prompt: Vec<ContentBlock>,
        #[serde(deserialize_with = "version_2::origin")]
        origin: TurnOrigin,
    },
    /// A turn ended: the agent's answer, or why it failed. Journals from before answers were
    /// kept recorded only the stop reason.
    #[serde(rename_all = "camelCase")]
    TurnEnded {
        #[serde(alias = "sessionId")]
        thread_id: ThreadId,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        response: Option<PromptResponse>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        stop_reason: Option<StopReason>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        error: Option<Error>,
    },
    /// The thread's agent was started again (`thread/reopen`).
    #[serde(rename_all = "camelCase")]
    AgentReopened {
        agent: Box<ThreadAgent>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        previous: Option<AgentRelease>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        modes: Option<SessionModeState>,
        #[serde(default)]
        config_options: Vec<SessionConfigOption>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        failed: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    Closed {
        reason: String,
        at_ms: u64,
        /// The client that closed it for everyone.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "version_2::some_origin"
        )]
        by: Option<TurnOrigin>,
    },
    /// Something the Host told the thread's clients.
    Notice {
        text: String,
    },
    /// The thread was renamed through the Host: its title from now on.
    Renamed {
        title: String,
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "version_2::some_origin"
        )]
        by: Option<TurnOrigin>,
    },
    /// A client changed the thread's labels (`thread/label`, WVE-173): all of them, after.
    Labelled {
        labels: Vec<String>,
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "version_2::some_origin"
        )]
        by: Option<TurnOrigin>,
    },
    /// A client named the thread its work goes on in (`thread/setSuccessor`, WVE-168).
    ContinuedIn {
        successor: ThreadId,
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "version_2::some_origin"
        )]
        by: Option<TurnOrigin>,
    },
    /// A prompt joined the queue; `at` is when.
    #[serde(rename_all = "camelCase")]
    Queued {
        queued_id: QueuedId,
        prompt: Vec<ContentBlock>,
        #[serde(deserialize_with = "version_2::origin")]
        origin: TurnOrigin,
        /// The request key it was queued under, which a repeat finds it by.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        key: Option<String>,
    },
    /// A client took a prompt out of the queue.
    #[serde(rename_all = "camelCase")]
    Unqueued {
        queued_id: QueuedId,
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "version_2::some_origin"
        )]
        by: Option<TurnOrigin>,
    },
    QueuePaused {
        reason: QueuePause,
    },
    QueueResumed {
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "version_2::some_origin"
        )]
        by: Option<TurnOrigin>,
    },
}

/// Reading what Hosts of the Host protocol's version 2 journaled, before it said thread
/// (WVE-200). Their records name their thread `sessionId`, which the records' `alias` takes, and
/// an origin in another thread `{"session": {"sessionId": …}}`, which these take as version 3's
/// `{"thread": {"threadId": …}}`. Records are read this way, never rewritten.
mod version_2 {
    use serde::Deserialize;
    use serde::Deserializer;
    use serde::de::Error as _;
    use serde_json::Value;
    use weave_host_protocol::queue::QueuedPrompt;
    use weave_host_protocol::threads::TurnOrigin;

    pub(super) fn origin<'de, D: Deserializer<'de>>(
        deserializer: D,
    ) -> Result<TurnOrigin, D::Error> {
        let mut value = Value::deserialize(deserializer)?;
        upgrade(&mut value);
        serde_json::from_value(value).map_err(D::Error::custom)
    }

    pub(super) fn some_origin<'de, D: Deserializer<'de>>(
        deserializer: D,
    ) -> Result<Option<TurnOrigin>, D::Error> {
        let mut value = Value::deserialize(deserializer)?;
        upgrade(&mut value);
        serde_json::from_value(value).map_err(D::Error::custom)
    }

    pub(super) fn queue<'de, D: Deserializer<'de>>(
        deserializer: D,
    ) -> Result<Vec<QueuedPrompt>, D::Error> {
        let mut value = Value::deserialize(deserializer)?;
        if let Value::Array(prompts) = &mut value {
            for prompt in prompts {
                if let Some(origin) = prompt.get_mut("origin") {
                    upgrade(origin);
                }
            }
        }
        serde_json::from_value(value).map_err(D::Error::custom)
    }

    /// `{"session": {"sessionId": …, …}}` becomes `{"thread": {"threadId": …, …}}`; any other
    /// origin stays as it is.
    fn upgrade(origin: &mut Value) {
        let Value::Object(variant) = origin else {
            return;
        };
        if variant.len() != 1 {
            return;
        }
        let Some(mut fields) = variant.remove("session") else {
            return;
        };
        if let Value::Object(fields) = &mut fields
            && let Some(id) = fields.remove("sessionId")
        {
            fields.insert("threadId".to_owned(), id);
        }
        variant.insert("thread".to_owned(), fields);
    }
}

impl Entry {
    /// Whether someone did something in the thread, which is what its last activity goes by.
    /// The agent telling its commands, modes, settings, usage or title, as it does when the Host
    /// takes the thread up, isn't; nor are the Host's notices, a reopened agent, a paused
    /// queue or closing.
    pub(crate) fn is_activity(&self) -> bool {
        match self {
            Entry::Update { notification } => matches!(
                notification.update,
                SessionUpdate::UserMessageChunk(_)
                    | SessionUpdate::AgentMessageChunk(_)
                    | SessionUpdate::AgentThoughtChunk(_)
                    | SessionUpdate::ToolCall(_)
                    | SessionUpdate::ToolCallUpdate(_)
                    | SessionUpdate::Plan(_)
            ),
            Entry::AgentReopened { .. }
            | Entry::Closed { .. }
            | Entry::Notice { .. }
            | Entry::ContinuedIn { .. }
            | Entry::Labelled { .. }
            | Entry::QueuePaused { .. } => false,
            Entry::Header { .. }
            | Entry::TerminalOutput { .. }
            | Entry::TerminalExit { .. }
            | Entry::TurnStarted { .. }
            | Entry::TurnSteered { .. }
            | Entry::TurnEnded { .. }
            | Entry::Renamed { .. }
            | Entry::Queued { .. }
            | Entry::Unqueued { .. }
            | Entry::QueueResumed { .. } => true,
        }
    }

    pub(crate) fn header(
        thread_id: ThreadId,
        agent: AgentSpec,
        agent_id: &str,
        cwd: PathBuf,
        policy: PermissionPolicy,
        title: Option<String>,
        git: Option<GitLocation>,
    ) -> Self {
        Self::Header {
            version: VERSION,
            thread_id,
            agent,
            choice: Some(RecordedChoice::Named(agent_id.to_owned())),
            cwd,
            policy,
            created_ms: now_ms(),
            title,
            git,
            queue: Vec::new(),
            queue_paused: None,
            started_by: None,
            started_by_host: None,
            successor: None,
            labels: Vec::new(),
            usage: None,
        }
    }

    pub(crate) fn turn_ended(thread_id: ThreadId, result: &Result<PromptResponse, Error>) -> Self {
        let (response, error) = match result {
            Ok(response) => (Some(response.clone()), None),
            Err(error) => (None, Some(error.clone())),
        };
        Self::TurnEnded {
            thread_id,
            response,
            stop_reason: None,
            error,
        }
    }

    /// The entry as clients are sent it; none for the header.
    pub(crate) fn event(&self) -> Option<ThreadEvent> {
        Some(match self {
            Self::Header { .. } => return None,
            Self::Update { notification } => ThreadEvent::Update {
                notification: notification.clone(),
            },
            Self::TerminalOutput { terminal_id, data } => ThreadEvent::TerminalOutput {
                terminal_id: terminal_id.clone(),
                data: data.clone(),
            },
            Self::TerminalExit {
                terminal_id,
                status,
            } => ThreadEvent::TerminalExit {
                terminal_id: terminal_id.clone(),
                status: status.clone(),
            },
            Self::TurnStarted {
                thread_id,
                prompt,
                origin,
                queued_id,
                turn_id,
                continues,
                ..
            } => ThreadEvent::TurnStarted {
                thread_id: thread_id.clone(),
                prompt: prompt.clone(),
                origin: origin.clone().unwrap_or(TurnOrigin::Run {}),
                queued_id: queued_id.clone(),
                turn_id: turn_id.clone().or_else(|| queued_id.clone()),
                continues: continues.clone(),
            },
            Self::TurnSteered {
                thread_id,
                prompt,
                origin,
            } => ThreadEvent::TurnSteered {
                thread_id: thread_id.clone(),
                prompt: prompt.clone(),
                origin: origin.clone(),
            },
            Self::TurnEnded {
                thread_id,
                response,
                stop_reason,
                error,
            } => ThreadEvent::TurnEnded {
                thread_id: thread_id.clone(),
                response: response
                    .clone()
                    .or_else(|| stop_reason.map(PromptResponse::new)),
                error: error.clone(),
            },
            Self::AgentReopened {
                agent,
                previous,
                modes,
                config_options,
                failed,
            } => ThreadEvent::AgentReopened {
                agent: agent.clone(),
                previous: previous.clone(),
                modes: modes.clone(),
                config_options: config_options.clone(),
                failed: failed.clone(),
            },
            Self::Closed { reason, by, .. } => ThreadEvent::Closed {
                reason: reason.clone(),
                by: by.clone(),
            },
            Self::Notice { text } => ThreadEvent::Notice { text: text.clone() },
            Self::Renamed { title, by } => ThreadEvent::Renamed {
                title: title.clone(),
                by: by.clone(),
            },
            Self::Labelled { labels, by } => ThreadEvent::Labelled {
                labels: labels.clone(),
                by: by.clone(),
            },
            Self::ContinuedIn { successor, by } => ThreadEvent::ContinuedIn {
                successor: successor.clone(),
                by: by.clone(),
            },
            Self::Queued {
                queued_id,
                prompt,
                origin,
                ..
            } => ThreadEvent::Queued {
                queued_id: queued_id.clone(),
                prompt: prompt.clone(),
                origin: origin.clone(),
            },
            Self::Unqueued { queued_id, by } => ThreadEvent::Unqueued {
                queued_id: queued_id.clone(),
                by: by.clone(),
            },
            Self::QueuePaused { reason } => ThreadEvent::QueuePaused { reason: *reason },
            Self::QueueResumed { by } => ThreadEvent::QueueResumed { by: by.clone() },
        })
    }
}

pub(crate) struct Journal {
    records: Vec<Record>,
    /// Where records are appended, unless the journal only lives in memory or writing failed.
    file: Option<File>,
    /// The file's path, unless the journal only lives in memory.
    path: Option<PathBuf>,
    /// When writing last failed, while the file is behind memory.
    failed_at: Option<Instant>,
    /// How long after a failure to try again.
    retry_interval: Duration,
}

impl Journal {
    fn new(records: Vec<Record>, file: Option<File>, path: Option<PathBuf>) -> Self {
        Self {
            records,
            file,
            path,
            failed_at: None,
            retry_interval: RETRY_INTERVAL,
        }
    }

    /// A journal that is never written down, for a Host inside one client.
    pub(crate) fn memory(header: Entry) -> Self {
        let mut journal = Self::new(Vec::new(), None, None);
        journal.append(header);
        journal
    }

    /// A new journal for a thread in `dir`, replacing any earlier one of the same thread.
    pub(crate) fn create(dir: &Path, thread_id: &ThreadId, header: Entry) -> io::Result<Self> {
        create_private_dir(dir)?;
        let path = path_for(dir, thread_id);
        let file = private_file(&path, true)?;
        let mut journal = Self::new(Vec::new(), Some(file), Some(path));
        journal.append(header);
        Ok(journal)
    }

    /// Continue the journal at `path`, already read as `records`.
    pub(crate) fn reopen(path: &Path, records: Vec<Record>) -> io::Result<Self> {
        Ok(Self::new(
            records,
            Some(private_file(path, false)?),
            Some(path.to_path_buf()),
        ))
    }

    /// Remove the journal from disk: its thread has nothing worth keeping.
    pub(crate) fn discard(&mut self) {
        self.file = None;
        self.failed_at = None;
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
        let line = serde_json::to_string(&record).map_err(io::Error::other);
        let at = record.at;
        self.records.push(record);
        if self.path.is_some() {
            match (&mut self.file, self.failed_at) {
                (Some(file), None) => {
                    if let Err(error) = line.and_then(|line| writeln!(file, "{line}")) {
                        // The thread carries on, the record kept in memory.
                        tracing::warn!(
                            %error,
                            "journal write failed; it's written again in full once it can be"
                        );
                        self.file = None;
                        self.failed_at = Some(Instant::now());
                    }
                }
                _ => self.retry(false),
            }
        }
        (self.head(), at)
    }

    /// Write a journal that fell behind out again, now: as its thread stops.
    pub(crate) fn flush(&mut self) {
        if self.path.is_some() && self.failed_at.is_some() {
            self.retry(true);
        }
    }

    /// Write the journal out in full, if a failure was long enough ago or `now`.
    fn retry(&mut self, now: bool) {
        let due = self
            .failed_at
            .is_none_or(|failed| now || failed.elapsed() >= self.retry_interval);
        if !due {
            return;
        }
        match self.rewrite() {
            Ok(file) => {
                tracing::info!("journal written again in full");
                self.file = Some(file);
                self.failed_at = None;
            }
            Err(error) => {
                tracing::debug!(%error, "journal still can't be written");
                self.failed_at = Some(Instant::now());
            }
        }
    }

    /// Every record, to a new file that then replaces the journal's, so the old one stays
    /// whole until the new one is. Returns the new file, open for appending.
    fn rewrite(&self) -> io::Result<File> {
        let Some(path) = &self.path else {
            return Err(io::Error::other("the journal has no file"));
        };
        let temporary = path.with_extension("jsonl.tmp");
        let written = (|| {
            let mut file = private_file(&temporary, true)?;
            for record in &self.records {
                let line = serde_json::to_string(record).map_err(io::Error::other)?;
                writeln!(file, "{line}")?;
            }
            file.sync_all()?;
            std::fs::rename(&temporary, path)
        })();
        if let Err(error) = written {
            let _ = std::fs::remove_file(&temporary);
            return Err(error);
        }
        private_file(path, false)
    }

    pub(crate) fn records(&self) -> &[Record] {
        &self.records
    }

    /// The position of the last record; 0 when there's only the header.
    pub(crate) fn head(&self) -> u64 {
        u64::try_from(self.records.len().saturating_sub(1)).unwrap_or(u64::MAX)
    }

    /// The journal's id: when its header was written. A thread opened again after it closed
    /// gets a new journal, and with it a new id.
    pub(crate) fn id(&self) -> String {
        match self.records.first().map(|record| &record.entry) {
            Some(Entry::Header { created_ms, .. }) => created_ms.to_string(),
            _ => "0".to_owned(),
        }
    }
}

/// The journal file for `thread_id`: its id, with anything unsafe in a file name escaped.
pub(crate) fn path_for(dir: &Path, thread_id: &ThreadId) -> PathBuf {
    let mut name = String::new();
    for byte in thread_id.to_string().bytes() {
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

/// What a journal says about its thread: which agent, where, under which policy, and
/// whether it was closed or left open by a Host that stopped.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Recorded {
    pub agent: AgentSpec,
    pub choice: Option<RecordedChoice>,
    pub cwd: PathBuf,
    pub policy: PermissionPolicy,
    pub closed: bool,
    /// When someone last did something in it ([`Entry::is_activity`]).
    pub last_activity_ms: u64,
    /// The title it shows: the one it was renamed to, or else the last its agent gave it.
    pub title: Option<String>,
    /// Where in a git repository `cwd` is, as the Host last read it: when the journal began,
    /// and while this Host held the thread open.
    pub git: Option<GitLocation>,
    /// The thread whose agent started it, for a delegated thread.
    pub started_by: Option<ThreadId>,
    /// The other Host `started_by` is on, when it isn't this one.
    pub started_by_host: Option<String>,
    /// The thread its work goes on in, which a client named (WVE-168).
    pub successor: Option<ThreadId>,
    /// Its labels (WVE-173); a labelled thread's journal is kept past pruning.
    pub labels: Vec<String>,
    /// Its context usage and last compaction (WVE-174).
    pub usage: Usage,
}

/// What a header carries of a closed thread's [`Usage`].
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CarriedUsage {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) context: Option<ContextUsage>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) last_compaction: Option<LastCompaction>,
}

/// A thread's context usage and its last completed compaction, as its own agent's updates
/// give them (WVE-174): ACP's `usage_update` and `compaction_update`, nothing else.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Usage {
    pub context: Option<ContextUsage>,
    pub last_compaction: Option<LastCompaction>,
    /// The last completed compaction's id, so the same one again, as a replay sends it,
    /// changes nothing.
    compaction_id: Option<CompactionId>,
}

impl Usage {
    /// Take in `update`, which the thread's own agent sent at `at`.
    pub(crate) fn note(&mut self, update: &SessionUpdate, at: u64) {
        match update {
            SessionUpdate::UsageUpdate(usage) => {
                self.context = Some(ContextUsage {
                    used: usage.used,
                    size: usage.size,
                });
                // The first report after a compaction says what it left.
                if let Some(last) = &mut self.last_compaction
                    && last.used.is_none()
                {
                    last.used = Some(usage.used);
                }
            }
            SessionUpdate::CompactionUpdate(update)
                if update.status == CompactionStatus::Completed
                    && self.compaction_id.as_ref() != Some(&update.compaction_id) =>
            {
                self.compaction_id = Some(update.compaction_id.clone());
                self.last_compaction = Some(LastCompaction { at, used: None });
            }
            _ => {}
        }
    }

    /// Take in `entry`, journaled at `at`, of the thread `root`.
    fn note_entry(&mut self, entry: &Entry, at: u64, root: &ThreadId) {
        match entry {
            Entry::Header { usage, .. } => {
                self.context = usage.as_ref().and_then(|usage| usage.context);
                self.last_compaction = usage.as_ref().and_then(|usage| usage.last_compaction);
            }
            Entry::Update { notification } if notification.session_id == *root => {
                self.note(&notification.update, at);
            }
            _ => {}
        }
    }
}

/// The context usage and last compaction of the thread `records` journal.
pub(crate) fn usage(records: &[Record]) -> Usage {
    let Some(Entry::Header { thread_id, .. }) = records.first().map(|record| &record.entry) else {
        return Usage::default();
    };
    let mut usage = Usage::default();
    for record in records {
        usage.note_entry(&record.entry, record.at, thread_id);
    }
    usage
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

/// The title the Host keeps for the thread `records` journal: the last it was renamed to,
/// or the one its journal began with.
pub(crate) fn kept_title(records: &[Record]) -> Option<String> {
    records
        .iter()
        .fold(None, |kept, record| match &record.entry {
            Entry::Header { title, .. } => title.clone().or(kept),
            Entry::Renamed { title, .. } => Some(title.clone()),
            _ => kept,
        })
}

/// The labels of the thread `records` journal: the last a client gave it, or those its journal
/// began with.
pub(crate) fn labels(records: &[Record]) -> Vec<String> {
    records
        .iter()
        .fold(Vec::new(), |labels, record| match &record.entry {
            Entry::Header { labels, .. } | Entry::Labelled { labels, .. } => labels.clone(),
            _ => labels,
        })
}

/// The successor a client named for the thread `records` journal, or the one its journal
/// began with.
pub(crate) fn successor(records: &[Record]) -> Option<ThreadId> {
    records
        .iter()
        .fold(None, |named, record| match &record.entry {
            Entry::Header { successor, .. } => successor.clone().or(named),
            Entry::ContinuedIn { successor, .. } => Some(successor.clone()),
            _ => named,
        })
}

/// The last title the agent of the thread `records` journal gave it, its subagents' aside.
pub(crate) fn agent_title(records: &[Record]) -> Option<String> {
    let Entry::Header { thread_id, .. } = &records.first()?.entry else {
        return None;
    };
    records
        .iter()
        .rev()
        .find_map(|record| title_given(&record.entry, thread_id))
}

/// The title `entry` has the agent of `root` give it.
fn title_given(entry: &Entry, root: &ThreadId) -> Option<String> {
    match entry {
        Entry::Update { notification } if notification.session_id == *root => {
            match &notification.update {
                SessionUpdate::SessionInfoUpdate(info) => info.title.value().cloned(),
                _ => None,
            }
        }
        _ => None,
    }
}

/// The title the thread `records` journal shows: the one it was renamed to, or else the last
/// its agent gave it.
pub(crate) fn shown_title(records: &[Record]) -> Option<String> {
    kept_title(records).or_else(|| agent_title(records))
}

/// When someone last did something in the thread `records` journal, if its records are timed.
pub(crate) fn last_activity(records: &[Record]) -> Option<u64> {
    records
        .iter()
        .rev()
        .find(|record| record.entry.is_activity())
        .map(|record| record.at)
        .filter(|at| *at > 0)
}

/// The thread whose agent started the thread `records` journal, as its header says, and
/// the other Host that thread is on when it isn't this one.
pub(crate) fn started_by(records: &[Record]) -> (Option<ThreadId>, Option<String>) {
    match records.first().map(|record| &record.entry) {
        Some(Entry::Header {
            started_by,
            started_by_host,
            ..
        }) => (started_by.clone(), started_by_host.clone()),
        _ => (None, None),
    }
}

/// The turn of `root` in `records` that `turn_id` names, or without one the latest: its prompt,
/// where it is, and the agent's last message in it, its message chunks since the last tool
/// call, thought or other message. A turn still queued is found in the queue the records leave.
/// Whether it waits on a person isn't journaled: an open thread's caller says so.
pub(crate) fn turn(
    records: &[Record],
    root: &ThreadId,
    turn_id: Option<&str>,
) -> Option<LatestTurn> {
    let start = records.iter().rposition(|record| match &record.entry {
        Entry::TurnStarted {
            thread_id,
            turn_id: id,
            queued_id,
            ..
        } if thread_id == root => turn_id.is_none_or(|wanted| {
            id.as_ref()
                .or(queued_id.as_ref())
                .is_some_and(|id| id == wanted)
        }),
        _ => false,
    });
    let Some(start) = start else {
        let wanted = turn_id?;
        let queued = Queue::from_records(records)
            .prompts
            .into_iter()
            .find(|prompt| prompt.id == wanted)?;
        return Some(LatestTurn {
            turn_id: Some(queued.id),
            state: TurnState::Queued,
            continues: None,
            continued_in: None,
            prompt: queued.prompt,
            origin: queued.origin,
            started_at: queued.queued_at,
            running: false,
            response: None,
            error: None,
            message: None,
        });
    };
    let Entry::TurnStarted {
        prompt,
        origin,
        turn_id: id,
        queued_id,
        continues,
        ..
    } = &records[start].entry
    else {
        return None;
    };
    let turn_id = id.clone().or_else(|| queued_id.clone());
    let continued_in = turn_id.as_ref().and_then(|ended| {
        records[start + 1..]
            .iter()
            .find_map(|record| match &record.entry {
                Entry::TurnStarted {
                    thread_id,
                    turn_id,
                    continues: Some(continues),
                    ..
                } if thread_id == root && continues == ended => turn_id.clone(),
                _ => None,
            })
    });
    let mut turn = LatestTurn {
        turn_id,
        state: TurnState::Running,
        continues: continues.clone(),
        continued_in,
        prompt: prompt.clone(),
        origin: origin.clone().unwrap_or(TurnOrigin::Run {}),
        started_at: records[start].at,
        running: true,
        response: None,
        error: None,
        message: None,
    };
    let mut message = String::new();
    // Something other than the agent's message came since its last chunk.
    let mut broken = false;
    for record in &records[start + 1..] {
        match &record.entry {
            Entry::Update { notification } if notification.session_id == *root => {
                match &notification.update {
                    SessionUpdate::AgentMessageChunk(chunk) => {
                        if std::mem::take(&mut broken) {
                            message.clear();
                        }
                        if let ContentBlock::Text(text) = &chunk.content {
                            message.push_str(&text.text);
                        }
                    }
                    SessionUpdate::AgentThoughtChunk(_)
                    | SessionUpdate::UserMessageChunk(_)
                    | SessionUpdate::ToolCall(_)
                    | SessionUpdate::ToolCallUpdate(_) => broken = true,
                    _ => {}
                }
            }
            Entry::TurnSteered { thread_id, .. } if thread_id == root => broken = true,
            Entry::TurnEnded {
                thread_id,
                response,
                stop_reason,
                error,
            } if thread_id == root => {
                turn.running = false;
                turn.response = response
                    .clone()
                    .or_else(|| stop_reason.map(PromptResponse::new));
                turn.error.clone_from(error);
                turn.state = ended(turn.response.as_ref(), turn.error.as_ref());
                break;
            }
            _ => {}
        }
    }
    turn.message = (!message.is_empty()).then_some(message);
    Some(turn)
}

/// How a turn that ended with `response`, or failed with `error`, stands.
fn ended(response: Option<&PromptResponse>, error: Option<&Error>) -> TurnState {
    match (response, error) {
        (_, Some(error)) if errors::is(error, errors::INTERRUPTED) => TurnState::Interrupted,
        (_, Some(_)) | (None, None) => TurnState::Failed,
        (Some(response), None) => match response.stop_reason {
            StopReason::EndTurn => TurnState::Ended,
            StopReason::Cancelled => TurnState::Cancelled,
            _ => TurnState::Stopped,
        },
    }
}

/// The record of `thread_id`'s journal in `dir`, if it has one.
pub(crate) fn recorded(dir: &Path, thread_id: &ThreadId) -> Option<Recorded> {
    record_of(&path_for(dir, thread_id)).map(|(_, recorded)| recorded)
}

/// Every journal's record in `dir`, by thread.
pub(crate) fn index(dir: &Path) -> HashMap<ThreadId, Recorded> {
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

/// How many of a journal's last records [`record_of`] looks through for its last activity.
const TAIL: usize = 64;

/// What a journal's header and last records say about its thread, and the title it shows.
/// Only the header, the records that can carry a title, and the last [`TAIL`] are parsed.
fn record_of(path: &Path) -> Option<(ThreadId, Recorded)> {
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
    let Entry::Header {
        thread_id,
        agent,
        choice,
        cwd,
        policy,
        git,
        started_by,
        started_by_host,
        title: mut renamed,
        mut successor,
        mut labels,
        usage: carried,
        ..
    } = serde_json::from_str::<Record>(&header).ok()?.entry
    else {
        return None;
    };
    let mut agent_title = None;
    let carried = carried.map(|carried| *carried).unwrap_or_default();
    let mut usage = Usage {
        context: carried.context,
        last_compaction: carried.last_compaction,
        compaction_id: None,
    };
    let mut tail = VecDeque::from([header]);
    for line in lines {
        // Usage and compactions, the thread's own only.
        if (line.contains(r#""sessionUpdate":"usage_update""#)
            || line.contains(r#""sessionUpdate":"compaction_update""#))
            && let Ok(record) = serde_json::from_str::<Record>(&line)
        {
            usage.note_entry(&record.entry, record.at, &thread_id);
        }
        // Escaped inside a string, these can't match text an agent wrote.
        if line.starts_with(r#"{"type":"renamed""#)
            || line.starts_with(r#"{"type":"continuedIn""#)
            || line.starts_with(r#"{"type":"labelled""#)
            || line.contains(r#""sessionUpdate":"session_info_update""#)
        {
            match serde_json::from_str::<Record>(&line).map(|record| record.entry) {
                Ok(Entry::Renamed { title, .. }) => renamed = Some(title),
                Ok(Entry::ContinuedIn {
                    successor: named, ..
                }) => successor = Some(named),
                Ok(Entry::Labelled { labels: given, .. }) => labels = given,
                Ok(entry) => {
                    if let Some(title) = title_given(&entry, &thread_id) {
                        agent_title = Some(title);
                    }
                }
                Err(_) => {}
            }
        }
        if tail.len() == TAIL {
            tail.pop_front();
        }
        tail.push_back(line);
    }
    let tail: Vec<Record> = tail
        .iter()
        .filter_map(|line| serde_json::from_str(line).ok())
        .collect();
    let closed = tail
        .last()
        .is_some_and(|record| matches!(record.entry, Entry::Closed { .. }));
    // Past the tail, the activity was before its first record.
    let last_activity_ms = last_activity(&tail)
        .or_else(|| tail.first().map(|record| record.at).filter(|at| *at > 0))
        .unwrap_or(modified);
    Some((
        thread_id,
        Recorded {
            agent,
            choice,
            cwd,
            policy,
            closed,
            last_activity_ms,
            title: renamed.or(agent_title),
            git,
            started_by,
            started_by_host,
            successor,
            labels,
            usage,
        },
    ))
}

/// End the journal a stopped Host left open for `thread_id` as closed, its thread not
/// running: nobody took it up. It keeps the time it was last written to, which is its
/// thread's last activity and what pruning goes by.
pub(crate) fn close(dir: &Path, thread_id: &ThreadId, reason: &str) -> io::Result<()> {
    let path = path_for(dir, thread_id);
    let modified = std::fs::metadata(&path)?.modified()?;
    let records = read(&path)?;
    if is_closed(&records) {
        return Ok(());
    }
    let mut journal = Journal::reopen(&path, records)?;
    journal.append(Entry::Closed {
        reason: reason.to_owned(),
        at_ms: now_ms(),
        by: None,
    });
    journal.flush();
    if journal.failed_at.is_some() {
        return Err(io::Error::other("the closing record couldn't be written"));
    }
    drop(journal);
    OpenOptions::new()
        .write(true)
        .open(&path)?
        .set_modified(modified)
}

/// Whether the thread the journal records was closed, rather than left by a Host that
/// stopped.
pub(crate) fn is_closed(records: &[Record]) -> bool {
    matches!(
        records.last().map(|record| &record.entry),
        Some(Entry::Closed { .. })
    )
}

/// What a journal records of the work done under request key `key`: the position of the
/// turn or queued prompt it started, which queued prompt that was, and whether it started a
/// turn.
pub(crate) fn find_key(records: &[Record], key: &str) -> Option<KeyedWork> {
    records
        .iter()
        .enumerate()
        .find_map(|(seq, record)| match &record.entry {
            Entry::TurnStarted {
                key: Some(found),
                queued_id,
                turn_id,
                thread_id,
                ..
            } if found == key => Some(KeyedWork {
                seq: u64::try_from(seq).unwrap_or(u64::MAX),
                thread_id: thread_id.clone(),
                queued_id: queued_id.clone(),
                turn_id: turn_id.clone().or_else(|| queued_id.clone()),
                started: true,
            }),
            Entry::Queued {
                key: Some(found),
                queued_id,
                ..
            } if found == key => Some(KeyedWork {
                seq: u64::try_from(seq).unwrap_or(u64::MAX),
                thread_id: records.first().and_then(|first| match &first.entry {
                    Entry::Header { thread_id, .. } => Some(thread_id.clone()),
                    _ => None,
                })?,
                queued_id: Some(queued_id.clone()),
                turn_id: Some(queued_id.clone()),
                started: false,
            }),
            _ => None,
        })
}

/// The work a request key started, as its thread's journal records it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct KeyedWork {
    pub(crate) seq: u64,
    /// The thread the turn started in, a subagent thread's when it was one's.
    pub(crate) thread_id: ThreadId,
    pub(crate) queued_id: Option<QueuedId>,
    /// The turn it started, or will once its queued prompt starts.
    pub(crate) turn_id: Option<TurnId>,
    pub(crate) started: bool,
}

/// The turns that started and never ended, as a Host that stopped under them leaves them.
pub(crate) fn open_turns(records: &[Record]) -> Vec<OpenTurn> {
    let mut open: Vec<OpenTurn> = Vec::new();
    for record in records {
        match &record.entry {
            Entry::TurnStarted {
                thread_id,
                origin,
                queued_id,
                turn_id,
                continues,
                ..
            } => open.push(OpenTurn {
                thread_id: thread_id.clone(),
                turn_id: turn_id.clone().or_else(|| queued_id.clone()),
                origin: origin.clone().unwrap_or(TurnOrigin::Run {}),
                continues: continues.clone(),
            }),
            Entry::TurnEnded { thread_id, .. } => {
                open.retain(|open| open.thread_id != *thread_id);
            }
            _ => {}
        }
    }
    open
}

/// A turn a stopped Host left running: journaled as started, and never as ended.
pub(crate) struct OpenTurn {
    pub(crate) thread_id: ThreadId,
    pub(crate) turn_id: Option<TurnId>,
    pub(crate) origin: TurnOrigin,
    /// The interrupted turn it continued, itself.
    pub(crate) continues: Option<TurnId>,
}

/// Remove journals untouched for `age`: closed threads, and ones left by a Host that
/// stopped and never taken up again. The `kept` threads' journals stay, however quiet: open
/// ones, and labelled ones, as a Bot's earlier threads are (WVE-173).
pub(crate) fn prune(dir: &Path, age: Duration, kept: &[ThreadId]) {
    let Ok(listing) = std::fs::read_dir(dir) else {
        return;
    };
    let cutoff = SystemTime::now().checked_sub(age).unwrap_or(UNIX_EPOCH);
    let kept: HashSet<PathBuf> = kept
        .iter()
        .map(|thread_id| path_for(dir, thread_id))
        .collect();
    for entry in listing.flatten() {
        let path = entry.path();
        let stale = path
            .extension()
            .is_some_and(|extension| extension == "jsonl")
            && !kept.contains(&path)
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

/// Move the journals a Host of the Host protocol's version 2 kept in `sessions`, beside `dir`,
/// to `dir`, the `threads` directory, once: when `dir` doesn't exist yet (WVE-200). Their
/// records are read as they were written. Whether it moved them.
pub(crate) fn move_from_version_2(dir: &Path) -> io::Result<bool> {
    if dir.file_name() != Some(OsStr::new("threads")) || dir.exists() {
        return Ok(false);
    }
    let before = dir.with_file_name("sessions");
    if !before.is_dir() {
        return Ok(false);
    }
    std::fs::rename(&before, dir)?;
    Ok(true)
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

pub(crate) fn private_file(path: &Path, truncate: bool) -> io::Result<File> {
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
    use weave_acp_core::schema::AvailableCommandsUpdate;
    use weave_acp_core::schema::ContentChunk;
    use weave_acp_core::schema::SessionInfoUpdate;
    use weave_acp_core::schema::SessionUpdate;

    use super::*;

    #[test]
    fn usage_is_the_latest_report_and_the_last_completed_compaction() {
        use weave_acp_core::schema::CompactionUpdate;
        use weave_acp_core::schema::UsageUpdate;

        let mut usage = Usage::default();
        let report = |used| SessionUpdate::UsageUpdate(UsageUpdate::new(used, 200_000));
        let compaction = |id: &str, status| {
            SessionUpdate::CompactionUpdate(CompactionUpdate::new(id.to_owned(), status))
        };
        usage.note(&report(150_000), 1);
        assert_eq!(
            usage.context,
            Some(ContextUsage {
                used: 150_000,
                size: 200_000
            })
        );
        // Only a completed one counts, and what the next report says it left.
        usage.note(&compaction("c1", CompactionStatus::InProgress), 2);
        usage.note(&compaction("c1", CompactionStatus::Failed), 3);
        assert_eq!(usage.last_compaction, None);
        usage.note(&compaction("c2", CompactionStatus::Completed), 4);
        assert_eq!(
            usage.last_compaction,
            Some(LastCompaction { at: 4, used: None })
        );
        usage.note(&report(40_000), 5);
        usage.note(&report(60_000), 6);
        assert_eq!(
            usage.last_compaction,
            Some(LastCompaction {
                at: 4,
                used: Some(40_000)
            })
        );
        // The same one again, as a replay sends it, changes nothing.
        usage.note(&compaction("c2", CompactionStatus::Completed), 7);
        assert_eq!(usage.last_compaction.map(|last| last.at), Some(4));
    }

    fn header(thread_id: &str) -> Entry {
        Entry::header(
            ThreadId::new(thread_id.to_owned()),
            AgentSpec::new("agent", ["--acp"]),
            "agent",
            "/repo".into(),
            PermissionPolicy::ask(),
            None,
            Some(git()),
        )
    }

    fn git() -> GitLocation {
        GitLocation {
            repo: "/repo".into(),
            worktree: "/repo".into(),
            branch: Some("main".to_owned()),
            remote: None,
        }
    }

    #[test]
    fn the_kept_title_is_the_last_rename_or_the_one_the_journal_began_with() {
        let record = |entry: Entry| Record { entry, at: 0 };
        let titled = |title: &str| {
            let mut header = header("s1");
            if let Entry::Header { title: kept, .. } = &mut header {
                *kept = Some(title.to_owned());
            }
            header
        };
        let renamed = |title: &str| Entry::Renamed {
            title: title.to_owned(),
            by: None,
        };
        assert_eq!(kept_title(&[record(header("s1"))]), None);
        assert_eq!(
            kept_title(&[record(titled("Carried on"))]).as_deref(),
            Some("Carried on")
        );
        assert_eq!(
            kept_title(&[
                record(titled("Carried on")),
                record(renamed("First")),
                record(renamed("Second")),
            ])
            .as_deref(),
            Some("Second")
        );
    }

    #[test]
    fn a_journal_shows_its_agents_last_title_or_its_rename_and_when_it_was_last_active() {
        let dir = tempfile::tempdir().expect("tempdir");
        let id = ThreadId::new("s1");
        let path = path_for(dir.path(), &id);
        let mut journal = Journal::create(dir.path(), &id, header("s1")).expect("create");
        let titled = |title: &str| Entry::Update {
            notification: Box::new(SessionNotification::new(
                "s1",
                SessionUpdate::SessionInfoUpdate(SessionInfoUpdate::new().title(title.to_owned())),
            )),
        };
        journal.append(titled("The agent's first title"));
        journal.append(titled("The agent's title"));
        let (_, active) = journal.append(update("hi"));
        // The agent telling its commands again, as when the Host takes the thread up, later.
        for _ in 0..3 {
            std::thread::sleep(Duration::from_millis(5));
            journal.append(Entry::Update {
                notification: Box::new(SessionNotification::new(
                    "s1",
                    SessionUpdate::AvailableCommandsUpdate(
                        AvailableCommandsUpdate::new(Vec::new()),
                    ),
                )),
            });
        }
        journal.flush();
        let record = recorded(dir.path(), &id).expect("recorded");
        assert_eq!(record.title.as_deref(), Some("The agent's title"));
        assert_eq!(record.last_activity_ms, active);
        let records = read(&path).expect("read");
        assert_eq!(last_activity(&records), Some(active));
        assert_eq!(shown_title(&records).as_deref(), Some("The agent's title"));

        // A rename holds over the agent's titles.
        journal.append(Entry::Renamed {
            title: "Renamed".to_owned(),
            by: None,
        });
        journal.append(titled("A later one"));
        journal.flush();
        let record = recorded(dir.path(), &id).expect("recorded");
        assert_eq!(record.title.as_deref(), Some("Renamed"));
        assert_eq!(
            shown_title(&read(&path).expect("read")).as_deref(),
            Some("Renamed")
        );
    }

    #[test]
    fn a_journal_reads_back_what_was_appended() {
        let dir = tempfile::tempdir().expect("tempdir");
        let id = ThreadId::new("s/1");
        let mut journal = Journal::create(dir.path(), &id, header("s/1")).expect("create");
        assert_eq!(journal.head(), 0);
        let (seq, _) = journal.append(Entry::TurnStarted {
            thread_id: id.clone(),
            at_ms: 1,
            prompt: vec![ContentBlock::from("hi".to_owned())],
            origin: None,
            queued_id: None,
            turn_id: Some("t1".to_owned()),
            key: Some("k1".to_owned()),
            continues: None,
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
        let open = open_turns(&records);
        assert_eq!(open.len(), 1);
        assert_eq!(open[0].thread_id, id);
        assert_eq!(open[0].turn_id.as_deref(), Some("t1"));
        assert_eq!(
            find_key(&records, "k1"),
            Some(KeyedWork {
                seq: 1,
                thread_id: id.clone(),
                queued_id: None,
                turn_id: Some("t1".to_owned()),
                started: true,
            })
        );
        assert_eq!(find_key(&records, "k2"), None);

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
            by: None,
        });
        assert_eq!(seq, 4);
        let records = read(&path).expect("read");
        assert!(open_turns(&records).is_empty());
        assert!(is_closed(&records));
        // Its record, alone and in the index.
        let recorded = recorded(dir.path(), &ThreadId::new("s/1")).expect("recorded");
        assert_eq!(recorded.agent_id(), Some("agent"));
        assert_eq!(recorded.cwd, PathBuf::from("/repo"));
        assert_eq!(recorded.git, Some(git()));
        assert!(recorded.closed);
        let index = index(dir.path());
        assert_eq!(index.get(&ThreadId::new("s/1")), Some(&recorded));
    }

    #[test]
    fn a_turn_says_where_it_is_and_the_agents_last_message() {
        use weave_acp_core::schema::ToolCall;
        let record = |entry: Entry| Record { entry, at: 9 };
        let id = ThreadId::new("s1");
        let chunk = |text: &str| update(text);
        let started =
            |prompt: &str, turn_id: Option<&str>, queued_id: Option<&str>| Entry::TurnStarted {
                thread_id: id.clone(),
                at_ms: 9,
                prompt: vec![ContentBlock::from(prompt.to_owned())],
                origin: None,
                queued_id: queued_id.map(str::to_owned),
                turn_id: turn_id.map(str::to_owned),
                key: None,
                continues: None,
            };
        let tool = Entry::Update {
            notification: Box::new(SessionNotification::new(
                "s1",
                SessionUpdate::ToolCall(ToolCall::new("t1", "Read a file")),
            )),
        };
        let mut records = vec![
            record(header("s1")),
            // A Host that gave turns no ids journaled this one.
            record(started("first", None, None)),
            record(chunk("Done before.")),
            record(Entry::turn_ended(
                id.clone(),
                &Ok(PromptResponse::new(StopReason::EndTurn)),
            )),
            record(started("second", Some("q-2"), Some("q-2"))),
            record(chunk("Let me look. ")),
            record(tool),
            record(chunk("Found it")),
            record(chunk(" in a.rs.")),
            record(Entry::Queued {
                queued_id: "q-3".to_owned(),
                prompt: vec![ContentBlock::from("third".to_owned())],
                origin: TurnOrigin::Run {},
                key: None,
            }),
        ];
        let running = turn(&records, &id, None).expect("a turn");
        assert_eq!(running.turn_id.as_deref(), Some("q-2"));
        assert_eq!(running.state, TurnState::Running);
        assert!(running.running);
        assert_eq!(
            running.prompt,
            vec![ContentBlock::from("second".to_owned())]
        );
        assert_eq!(running.message.as_deref(), Some("Found it in a.rs."));
        records.push(record(Entry::turn_ended(
            id.clone(),
            &Ok(PromptResponse::new(StopReason::Cancelled)),
        )));
        records.push(record(started("third", Some("q-3"), Some("q-3"))));
        records.push(record(chunk("Third.")));
        let ended = turn(&records, &id, Some("q-2")).expect("the second turn");
        assert!(!ended.running);
        assert_eq!(ended.state, TurnState::Cancelled);
        assert_eq!(
            ended.response.map(|response| response.stop_reason),
            Some(StopReason::Cancelled)
        );
        // The next turn's message isn't the second's.
        assert_eq!(ended.message.as_deref(), Some("Found it in a.rs."));
        assert_eq!(
            turn(&records, &id, None).and_then(|latest| latest.turn_id),
            Some("q-3".to_owned())
        );
        assert_eq!(turn(&records, &id, Some("q-9")), None);
        assert_eq!(turn(&records[..1], &id, None), None);
    }

    #[test]
    fn a_queued_turn_is_found_in_the_queue_until_it_starts() {
        let record = |entry: Entry| Record { entry, at: 5 };
        let id = ThreadId::new("s1");
        let records = vec![
            record(header("s1")),
            record(Entry::Queued {
                queued_id: "q-1".to_owned(),
                prompt: vec![ContentBlock::from("later".to_owned())],
                origin: TurnOrigin::Run {},
                key: None,
            }),
        ];
        let queued = turn(&records, &id, Some("q-1")).expect("queued");
        assert_eq!(queued.state, TurnState::Queued);
        assert!(!queued.running);
        assert_eq!(queued.started_at, 5);
        assert_eq!(turn(&records, &id, None), None);
    }

    #[test]
    fn an_ended_turn_states_how() {
        let response = |reason| Some(PromptResponse::new(reason));
        assert_eq!(
            ended(response(StopReason::EndTurn).as_ref(), None),
            TurnState::Ended
        );
        assert_eq!(
            ended(response(StopReason::MaxTokens).as_ref(), None),
            TurnState::Stopped
        );
        assert_eq!(
            ended(response(StopReason::Refusal).as_ref(), None),
            TurnState::Stopped
        );
        assert_eq!(
            ended(None, Some(&Error::internal_error())),
            TurnState::Failed
        );
        assert_eq!(ended(None, None), TurnState::Failed);
    }

    #[test]
    fn a_journal_left_open_closes_once_keeping_its_age() {
        let dir = tempfile::tempdir().expect("tempdir");
        let id = ThreadId::new("s1");
        let mut journal = Journal::create(dir.path(), &id, header("s1")).expect("create");
        journal.append(Entry::Notice {
            text: "hello".into(),
        });
        drop(journal);
        let path = path_for(dir.path(), &id);
        let age = || {
            std::fs::metadata(&path)
                .and_then(|metadata| metadata.modified())
                .expect("its age")
        };
        let left = SystemTime::now() - Duration::from_secs(3 * 24 * 60 * 60);
        OpenOptions::new()
            .write(true)
            .open(&path)
            .expect("open")
            .set_modified(left)
            .expect("age it");

        close(dir.path(), &id, "nobody took it up").expect("close");
        close(dir.path(), &id, "nobody took it up").expect("closing again changes nothing");
        let records = read(&path).expect("read");
        assert_eq!(records.len(), 3);
        assert!(is_closed(&records));
        assert_eq!(age(), left);
        assert!(recorded(dir.path(), &id).expect("recorded").closed);
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
            Some(ThreadEvent::TurnEnded { response: Some(response), .. })
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
        let threads = dir.path().join("threads");
        Journal::create(&threads, &"s1".into(), header("s1")).expect("create");
        let mode = |path: &Path| {
            std::fs::metadata(path)
                .map(|metadata| metadata.permissions().mode() & 0o777)
                .unwrap_or_default()
        };
        assert_eq!(mode(&threads), 0o700);
        assert_eq!(mode(&path_for(&threads, &"s1".into())), 0o600);
    }

    #[test]
    fn pruning_removes_old_journals_but_not_live_threads() {
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
        let kept = |id: &str| path_for(dir.path(), &ThreadId::new(id.to_owned())).exists();
        assert!(kept("live"));
        assert!(!kept("stale"));
        assert!(kept("recent"));
    }

    /// Writes fail from here on: the file handle can only read.
    fn break_writes(journal: &mut Journal) {
        let path = journal.path.clone().expect("a file");
        journal.file = Some(File::open(path).expect("read-only"));
        journal.retry_interval = Duration::ZERO;
    }

    fn update(text: &str) -> Entry {
        Entry::Update {
            notification: Box::new(SessionNotification::new(
                "s1",
                SessionUpdate::AgentMessageChunk(ContentChunk::new(text.into())),
            )),
        }
    }

    #[test]
    fn a_journal_that_couldnt_be_written_is_written_again_in_full() {
        let dir = tempfile::tempdir().expect("tempdir");
        let mut journal = Journal::create(dir.path(), &"s1".into(), header("s1")).expect("create");
        journal.append(update("one"));
        break_writes(&mut journal);
        // This one fails, and is kept in memory.
        journal.append(update("two"));
        let path = path_for(dir.path(), &"s1".into());
        assert_eq!(read(&path).expect("read").len(), 2);
        // The next one writes everything out again, in order, positions and all.
        let (seq, _) = journal.append(update("three"));
        assert_eq!(seq, 3);
        let on_disk = read(&path).expect("read");
        assert_eq!(on_disk.len(), 4);
        assert!(matches!(
            on_disk[2].entry.event(),
            Some(ThreadEvent::Update { notification })
                if matches!(&notification.update, SessionUpdate::AgentMessageChunk(chunk)
                    if matches!(&chunk.content, ContentBlock::Text(text) if text.text == "two"))
        ));
        // And it appends as before.
        journal.append(update("four"));
        assert_eq!(read(&path).expect("read").len(), 5);
        assert!(!dir.path().join("s1.jsonl.tmp").exists());
    }

    #[cfg(unix)]
    #[test]
    fn while_a_journal_cant_be_written_the_one_on_disk_stays_whole() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().expect("tempdir");
        let threads = dir.path().join("threads");
        let mut journal = Journal::create(&threads, &"s1".into(), header("s1")).expect("create");
        journal.append(update("one"));
        break_writes(&mut journal);
        // Nothing can be created beside it, so writing it out again fails too.
        std::fs::set_permissions(&threads, std::fs::Permissions::from_mode(0o500))
            .expect("read-only directory");
        // Unless the directory's mode holds nobody back, as for root in a container.
        if File::create(threads.join("probe")).is_ok() {
            return;
        }
        journal.append(update("two"));
        journal.append(update("three"));
        journal.flush();
        let path = path_for(&threads, &"s1".into());
        assert_eq!(read(&path).expect("read").len(), 2);
        // Once it can be written, stopping writes it all.
        std::fs::set_permissions(&threads, std::fs::Permissions::from_mode(0o700))
            .expect("writable directory");
        journal.flush();
        assert_eq!(read(&path).expect("read").len(), 4);
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
            by: None,
        });
        assert!(!path_for(dir.path(), &"s1".into()).exists());
    }
}
