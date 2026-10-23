//! Request keys (WVE-107): `session/run`, `turn/start` and `queue/add` take a key the caller
//! chooses, and a repeat answers as the first did, starting nothing. Each key is admitted here
//! before its request acts: a line in `admissions.jsonl` beside the journals, written through
//! to disk, then the answer once there is one, or a refusal that frees the key when the request
//! failed. The work a key started is journaled with it, so when a Host stopped between
//! admitting a key and answering, a repeat finds out from the session's journal whether the
//! work happened. Keys are forgotten after the journals' retention. Triggers (WVE-98) are to
//! admit their occurrences the same way.

use std::collections::HashMap;
use std::fs::File;
use std::io;
use std::io::BufRead;
use std::io::Write;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::time::Duration;

use agent_client_protocol::Error;
use serde::Deserialize;
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::Value;
use sha2::Digest;
use sha2::Sha256;
use tokio::sync::watch;
use weave_acp_core::schema::SessionId;
use weave_host_protocol::errors;
use weave_host_protocol::turns::MAX_KEY;

use crate::journal;
use crate::journal::now_ms;
use crate::session::lock;

/// One line of the record.
#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum Line {
    /// A request is acting under `key`.
    #[serde(rename_all = "camelCase")]
    Admitted {
        key: String,
        method: String,
        digest: String,
        at_ms: u64,
    },
    /// Its answer, which repeats get.
    Answered { key: String, answer: Value },
    /// It failed, so the key is free again.
    Refused { key: String },
}

struct Admission {
    method: String,
    digest: String,
    at_ms: u64,
    status: Status,
}

enum Status {
    /// Being answered now. Repeats wait until it settles, when this goes.
    Acting(watch::Sender<()>),
    Answered(Value),
    /// Admitted by a Host that stopped before answering.
    Unsettled,
}

#[derive(Default)]
struct Record {
    /// Where lines are appended; none for a Host that keeps nothing on disk, or once writing
    /// failed.
    file: Option<File>,
    keys: HashMap<String, Admission>,
}

pub(crate) struct Admissions {
    path: Option<PathBuf>,
    record: Mutex<Record>,
}

/// What admitting a key comes to.
pub(crate) enum Admitted<T> {
    /// The work happened already: the answer it got.
    Answered(T),
    /// Act, then settle the ticket with the answer. A ticket dropped unsettled frees the key.
    Act(Ticket),
}

/// A request acting under a key.
pub(crate) struct Ticket {
    admissions: Arc<Admissions>,
    key: String,
    /// A Host that stopped admitted it before answering: the work may have happened.
    unsettled: bool,
    settled: bool,
}

impl Ticket {
    pub(crate) fn key(&self) -> &str {
        &self.key
    }

    /// Whether a Host that stopped admitted the key without answering, so its work may have
    /// happened: look in the journal before acting.
    pub(crate) fn unsettled(&self) -> bool {
        self.unsettled
    }

    /// The request was answered with `answer`, which repeats get from now on.
    pub(crate) fn settle<T: Serialize>(mut self, answer: &T) {
        self.settled = true;
        let answer = serde_json::to_value(answer).unwrap_or(Value::Null);
        self.admissions.settle(&self.key, Some(answer));
    }
}

impl Drop for Ticket {
    fn drop(&mut self) {
        if !self.settled {
            self.admissions.settle(&self.key, None);
        }
    }
}

impl Admissions {
    /// The record beside the journals in `journals`, read back and pruned of keys older than
    /// `retention`; one in memory without journals on disk.
    pub(crate) fn load(journals: Option<&Path>, retention: Duration) -> Self {
        let path = journals.map(|dir| dir.with_file_name("admissions.jsonl"));
        let admissions = Self {
            path,
            record: Mutex::new(Record::default()),
        };
        if let Some(path) = &admissions.path {
            let keys = read(path);
            let mut record = lock(&admissions.record);
            record.keys = keys;
            drop(record);
            admissions.prune(retention);
        }
        admissions
    }

    /// Admit `key` for `method` with params that hash to `digest`: answered already, refused
    /// as another request's, or to act on. A repeat of a request still acting waits for it.
    pub(crate) async fn admit<T: DeserializeOwned>(
        self: &Arc<Self>,
        key: String,
        method: &str,
        digest: String,
    ) -> Result<Admitted<T>, Error> {
        if key.is_empty() || key.chars().count() > MAX_KEY {
            return Err(
                Error::invalid_params().data(format!("a request key is 1 to {MAX_KEY} characters"))
            );
        }
        loop {
            let mut acting = {
                let mut record = lock(&self.record);
                match record.keys.get_mut(&key) {
                    Some(admission) if admission.method != method || admission.digest != digest => {
                        return Err(errors::key_reused());
                    }
                    Some(admission) => match &admission.status {
                        Status::Answered(answer) => {
                            return serde_json::from_value(answer.clone())
                                .map(Admitted::Answered)
                                .map_err(|error| Error::internal_error().data(error.to_string()));
                        }
                        Status::Acting(sender) => sender.subscribe(),
                        Status::Unsettled => {
                            admission.status = Status::Acting(watch::Sender::new(()));
                            return Ok(Admitted::Act(self.ticket(key, true)));
                        }
                    },
                    None => {
                        let at_ms = now_ms();
                        self.write(
                            &mut record,
                            &Line::Admitted {
                                key: key.clone(),
                                method: method.to_owned(),
                                digest: digest.clone(),
                                at_ms,
                            },
                            true,
                        )?;
                        record.keys.insert(
                            key.clone(),
                            Admission {
                                method: method.to_owned(),
                                digest,
                                at_ms,
                                status: Status::Acting(watch::Sender::new(())),
                            },
                        );
                        return Ok(Admitted::Act(self.ticket(key, false)));
                    }
                }
            };
            // It settles when its sender goes; then look again.
            let _ = acting.changed().await;
        }
    }

    fn ticket(self: &Arc<Self>, key: String, unsettled: bool) -> Ticket {
        Ticket {
            admissions: Arc::clone(self),
            key,
            unsettled,
            settled: false,
        }
    }

    /// The request acting under `key` answered `answer`, or failed.
    fn settle(&self, key: &str, answer: Option<Value>) {
        let mut record = lock(&self.record);
        let line = match &answer {
            Some(answer) => Line::Answered {
                key: key.to_owned(),
                answer: answer.clone(),
            },
            None => Line::Refused {
                key: key.to_owned(),
            },
        };
        if let Err(error) = self.write(&mut record, &line, false) {
            tracing::warn!(%error, "couldn't record a request key's answer");
        }
        match answer {
            Some(answer) => {
                if let Some(admission) = record.keys.get_mut(key) {
                    admission.status = Status::Answered(answer);
                }
            }
            None => {
                record.keys.remove(key);
            }
        }
    }

    /// Append `line`, through to the disk when `sync`.
    fn write(&self, record: &mut Record, line: &Line, sync: bool) -> Result<(), Error> {
        let Some(path) = &self.path else {
            return Ok(());
        };
        let written = (|| {
            if record.file.is_none() {
                record.file = Some(append_to(path)?);
            }
            let Some(file) = record.file.as_mut() else {
                return Ok(());
            };
            let text = serde_json::to_string(line).map_err(io::Error::other)?;
            writeln!(file, "{text}")?;
            if sync {
                file.sync_data()?;
            }
            Ok::<(), io::Error>(())
        })();
        written.map_err(|error: io::Error| {
            record.file = None;
            Error::internal_error().data(format!("recording the request key: {error}"))
        })
    }

    /// Forget keys admitted longer than `retention` ago, and write the record out again with
    /// only the rest.
    pub(crate) fn prune(&self, retention: Duration) {
        let Some(path) = &self.path else {
            return;
        };
        let cutoff = now_ms().saturating_sub(u64::try_from(retention.as_millis()).unwrap_or(0));
        let mut record = lock(&self.record);
        let before = record.keys.len();
        record.keys.retain(|_, admission| {
            admission.at_ms >= cutoff || matches!(admission.status, Status::Acting(_))
        });
        if record.keys.len() == before {
            return;
        }
        let mut lines = Vec::new();
        for (key, admission) in &record.keys {
            lines.push(Line::Admitted {
                key: key.clone(),
                method: admission.method.clone(),
                digest: admission.digest.clone(),
                at_ms: admission.at_ms,
            });
            if let Status::Answered(answer) = &admission.status {
                lines.push(Line::Answered {
                    key: key.clone(),
                    answer: answer.clone(),
                });
            }
        }
        match rewrite(path, &lines) {
            Ok(file) => record.file = Some(file),
            Err(error) => tracing::warn!(%error, "couldn't prune the request keys"),
        }
    }
}

/// The record at `path`: each key's admission and, if it got one, its answer. Keys a request
/// was refused under are free again.
fn read(path: &Path) -> HashMap<String, Admission> {
    let mut keys = HashMap::new();
    let Ok(file) = File::open(path) else {
        return keys;
    };
    for line in io::BufReader::new(file).lines().map_while(Result::ok) {
        match serde_json::from_str::<Line>(&line) {
            Ok(Line::Admitted {
                key,
                method,
                digest,
                at_ms,
            }) => {
                keys.insert(
                    key,
                    Admission {
                        method,
                        digest,
                        at_ms,
                        status: Status::Unsettled,
                    },
                );
            }
            Ok(Line::Answered { key, answer }) => {
                if let Some(admission) = keys.get_mut(&key) {
                    admission.status = Status::Answered(answer);
                }
            }
            Ok(Line::Refused { key }) => {
                keys.remove(&key);
            }
            Err(error) => tracing::warn!(%error, "skipping a line of the request keys"),
        }
    }
    keys
}

/// The record at `path`, made if it isn't there, open for appending.
fn append_to(path: &Path) -> io::Result<File> {
    if let Some(parent) = path.parent() {
        journal::create_private_dir(parent)?;
    }
    let mut options = std::fs::OpenOptions::new();
    options.append(true).create(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path)
}

/// `lines` to a new file that then replaces the one at `path`. Returns it, open for
/// appending.
fn rewrite(path: &Path, lines: &[Line]) -> io::Result<File> {
    if let Some(parent) = path.parent() {
        journal::create_private_dir(parent)?;
    }
    let temporary = path.with_extension("jsonl.tmp");
    let written = (|| {
        let mut file = journal::private_file(&temporary, true)?;
        for line in lines {
            let text = serde_json::to_string(line).map_err(io::Error::other)?;
            writeln!(file, "{text}")?;
        }
        file.sync_all()?;
        std::fs::rename(&temporary, path)
    })();
    if let Err(error) = written {
        let _ = std::fs::remove_file(&temporary);
        return Err(error);
    }
    journal::private_file(path, false)
}

/// What a request's params hash to, its key aside, so a repeat with other params is told
/// apart.
pub(crate) fn digest(params: &impl Serialize) -> String {
    let text = serde_json::to_string(params).unwrap_or_default();
    let hash = Sha256::digest(text.as_bytes());
    hash.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// The session a request key's work happened in and what it was, found in the journals in
/// `dir`: `session_id`'s, or every one's when the request didn't name a session.
pub(crate) fn find_work(
    dir: &Path,
    session_id: Option<&SessionId>,
    key: &str,
) -> Option<journal::KeyedWork> {
    let paths: Vec<PathBuf> = match session_id {
        Some(session_id) => vec![journal::path_for(dir, session_id)],
        None => std::fs::read_dir(dir)
            .ok()?
            .flatten()
            .map(|entry| entry.path())
            .filter(|path| {
                path.extension()
                    .is_some_and(|extension| extension == "jsonl")
            })
            .collect(),
    };
    paths.iter().find_map(|path| {
        journal::read(path)
            .ok()
            .and_then(|records| journal::find_key(&records, key))
    })
}

#[cfg(test)]
mod tests {
    use pretty_assertions::assert_eq;

    use super::*;

    const RETENTION: Duration = Duration::from_secs(14 * 24 * 60 * 60);

    async fn admit(admissions: &Arc<Admissions>, key: &str, digest: &str) -> Admitted<u64> {
        admissions
            .admit(key.to_owned(), "turn/start", digest.to_owned())
            .await
            .expect("admitted")
    }

    #[tokio::test]
    async fn a_repeat_gets_the_first_answer_across_restarts() {
        let dir = tempfile::tempdir().expect("tempdir");
        let journals = dir.path().join("sessions");
        let admissions = Arc::new(Admissions::load(Some(&journals), RETENTION));
        let Admitted::Act(ticket) = admit(&admissions, "k1", "d1").await else {
            panic!("a new key acts");
        };
        assert!(!ticket.unsettled());
        ticket.settle(&42u64);
        assert!(matches!(
            admit(&admissions, "k1", "d1").await,
            Admitted::Answered(42)
        ));
        let reused = admissions
            .admit::<u64>("k1".to_owned(), "turn/start", "d2".to_owned())
            .await
            .err()
            .expect("other params are refused");
        assert!(errors::is(&reused, errors::KEY_REUSED));

        // A failed request frees its key; one a stopped Host never answered is unsettled.
        let Admitted::Act(failed) = admit(&admissions, "k2", "d").await else {
            panic!("a new key acts");
        };
        drop(failed);
        let Admitted::Act(left) = admit(&admissions, "k3", "d").await else {
            panic!("a new key acts");
        };
        std::mem::forget(left);
        drop(admissions);

        let admissions = Arc::new(Admissions::load(Some(&journals), RETENTION));
        assert!(matches!(
            admit(&admissions, "k1", "d1").await,
            Admitted::Answered(42)
        ));
        let Admitted::Act(again) = admit(&admissions, "k2", "d").await else {
            panic!("a freed key acts again");
        };
        assert!(!again.unsettled());
        let Admitted::Act(unsettled) = admit(&admissions, "k3", "d").await else {
            panic!("an unsettled key acts, once its journal is looked at");
        };
        assert!(unsettled.unsettled());
    }

    #[tokio::test]
    async fn a_repeat_waits_for_the_first_to_be_answered() {
        let admissions = Arc::new(Admissions::load(None, RETENTION));
        let Admitted::Act(ticket) = admit(&admissions, "k", "d").await else {
            panic!("a new key acts");
        };
        let repeat = tokio::spawn({
            let admissions = Arc::clone(&admissions);
            async move { admit(&admissions, "k", "d").await }
        });
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(!repeat.is_finished());
        ticket.settle(&7u64);
        assert!(matches!(
            repeat.await.expect("joined"),
            Admitted::Answered(7)
        ));
    }

    #[test]
    fn keys_are_forgotten_after_the_retention() {
        let dir = tempfile::tempdir().expect("tempdir");
        let journals = dir.path().join("sessions");
        let path = journals.with_file_name("admissions.jsonl");
        let old = now_ms() - 20 * 24 * 60 * 60 * 1000;
        std::fs::write(
            &path,
            format!(
                "{{\"type\":\"admitted\",\"key\":\"old\",\"method\":\"m\",\"digest\":\"d\",\"atMs\":{old}}}\n\
                 {{\"type\":\"admitted\",\"key\":\"new\",\"method\":\"m\",\"digest\":\"d\",\"atMs\":{}}}\n\
                 {{\"type\":\"answered\",\"key\":\"new\",\"answer\":1}}\n",
                now_ms()
            ),
        )
        .expect("record");
        let admissions = Admissions::load(Some(&journals), RETENTION);
        let keys: Vec<String> = lock(&admissions.record).keys.keys().cloned().collect();
        assert_eq!(keys, ["new"]);
        let kept = std::fs::read_to_string(&path).expect("record");
        assert!(!kept.contains("\"old\""), "{kept}");
        assert!(kept.contains("\"answered\""), "{kept}");
    }
}
