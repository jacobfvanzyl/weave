//! A Host's threads opened from the app, as tabs in the Rex on its computer, each running the
//! TUI on its thread (WVE-167, ADR 0025). Opt-in per Host: `[rex] open_threads = true`.
//!
//! `weave daemon` runs this beside the Host as a client of its own, in-process: it watches every
//! thread (`sessions/watch`) and drives the `rex` CLI, so neither the Host nor its protocol knows
//! of Rex (ADR 0018). It acts only on the Rex server on this computer, reached by its local
//! socket and never started, since a TUI attaches only to its own computer's Host: a thread on
//! another computer shows in the Rex app through that computer's own Rex.
//!
//! A thread opened or resumed from a paired device (its listing's `openedBy` names a `device`)
//! gets a tab, once per opening: in the Rex session named for its repository, made if missing,
//! labelled with the thread's title and renamed with it, running `weave --resume <id>` in its
//! directory, without taking focus. Openings already there when it starts are left alone. Which
//! tab shows which thread is kept in `rex-threads.json` beside the Host's journals and checked
//! against Rex, so a Host restart, or the app opening a thread whose tab is still there, makes no
//! second tab. A tab the person closed stays closed until a device opens the thread again.

use std::collections::BTreeMap;
use std::path::Path;
use std::path::PathBuf;
use std::process::Command;

use anyhow::Context as _;
use serde::Deserialize;
use serde::Serialize;
use tokio::sync::mpsc::UnboundedReceiver;
use weave_host_client::HostConnection;
use weave_host_client::HostEvent;
use weave_host_protocol::sessions::SessionListing;
use weave_host_protocol::sessions::SessionStatus;
use weave_host_protocol::sessions::TurnOrigin;
use weave_host_protocol::sessions::WatchSessionsRequest;

use crate::daemon;

/// This client's name to the Host.
const CLIENT: &str = "weave-rex";
/// A tab's label for a thread without a title yet.
const UNTITLED: &str = "New thread";

/// Follows the Host's threads until its connection ends, opening tabs in Rex for the ones a
/// device opens. `rex` is the CLI to drive; `record` where tabs are kept.
pub async fn follow(daemon: weave_host::Daemon, rex: PathBuf, record: PathBuf) {
    let connected = HostConnection::connect(
        daemon.connect_beside(),
        daemon::client_info(CLIENT),
        daemon::capabilities(CLIENT),
    )
    .await;
    let (connection, mut events) = match connected {
        Ok(connected) => connected,
        Err(error) => {
            tracing::warn!(%error, "threads won't open in Rex: no connection to the Host");
            return;
        }
    };
    let watched = match connection.send(WatchSessionsRequest {}).await {
        Ok(watched) => watched,
        Err(error) => {
            tracing::warn!(%error, "threads won't open in Rex: the Host lists none");
            return;
        }
    };
    let mut follower = Follower {
        rex: Rex::new(rex),
        record: Record::load(record),
        weave: std::env::current_exe().ok(),
    };
    // What's open already was opened before; only later openings get tabs.
    for listing in &watched.sessions {
        follower.seen(listing);
    }
    follow_events(&mut follower, &mut events).await;
}

async fn follow_events(follower: &mut Follower, events: &mut UnboundedReceiver<HostEvent>) {
    while let Some(event) = events.recv().await {
        match event {
            HostEvent::SessionUpdated(updated) => {
                let listing = updated.session;
                tokio::task::block_in_place(|| follower.updated(&listing));
            }
            HostEvent::SessionRemoved(removed) => follower.record.forget(&removed.session_id),
            _ => {}
        }
    }
}

/// What makes tabs, and remembers them.
struct Follower {
    rex: Rex,
    record: Record,
    /// What a tab runs: this weave.
    weave: Option<PathBuf>,
}

impl Follower {
    /// A listing at startup: its opening, if a device's, is one that was already there.
    fn seen(&mut self, listing: &SessionListing) {
        if let Some(at) = device_opening(listing) {
            self.record.seen(&listing.info.session_id.to_string(), at);
        }
    }

    /// A thread changed: one a device just opened gets a tab, and a tab follows its title.
    fn updated(&mut self, listing: &SessionListing) {
        let id = listing.info.session_id.to_string();
        let title = listing
            .info
            .title
            .clone()
            .filter(|title| !title.is_empty())
            .unwrap_or_else(|| UNTITLED.to_owned());
        if let Some(at) = device_opening(listing)
            && self.record.opening(&id) != Some(at)
        {
            self.record.seen(&id, at);
            let shown = self
                .record
                .tab(&id)
                .is_some_and(|tab| self.rex.has_block(&tab.session, &tab.block));
            if !shown {
                match self.open_tab(listing, &title) {
                    Ok(tab) => self.record.put(&id, tab),
                    Err(error) => {
                        tracing::info!(error = %format!("{error:#}"), thread = %id, "no tab in Rex");
                    }
                }
                return;
            }
        }
        // Renamed: so is its tab.
        if let Some(tab) = self.record.tab(&id).cloned()
            && tab.title != title
            && self
                .rex
                .rename_window(&tab.session, &tab.window, &title)
                .is_ok()
        {
            self.record.put(&id, Tab { title, ..tab });
        }
    }

    /// A tab for the thread `listing` describes, in its repository's session.
    fn open_tab(&self, listing: &SessionListing, title: &str) -> anyhow::Result<Tab> {
        if !self.rex.is_local()? {
            anyhow::bail!("the Rex server `rex` reaches isn't this computer's");
        }
        let weave = self
            .weave
            .as_ref()
            .context("this weave's own path isn't known")?;
        let group = group_of(listing);
        let command = tui_command(weave, &listing.info.session_id.to_string());
        let cwd = listing.info.cwd.display().to_string();
        let tab = match self.rex.session_labelled(&group)? {
            Some(session) => {
                let created = self.rex.new_window(&session, title, &cwd, &command)?;
                Tab {
                    session,
                    window: created.window,
                    block: created.block,
                    title: title.to_owned(),
                }
            }
            None => {
                let created = self.rex.new_session(&group, title, &cwd, &command)?;
                Tab {
                    session: created.session,
                    window: created.window,
                    block: created.block,
                    title: title.to_owned(),
                }
            }
        };
        Ok(tab)
    }
}

/// When a paired device opened the thread last, if one did and it's open.
fn device_opening(listing: &SessionListing) -> Option<u64> {
    if listing.state != SessionStatus::Open || listing.headless || listing.started_by.is_some() {
        return None;
    }
    match &listing.opened_by {
        Some(TurnOrigin::Client {
            device: Some(_), ..
        }) => listing.opened_at,
        _ => None,
    }
}

/// The Rex session a thread's tab goes in: named for its repository, by its primary worktree,
/// or for its directory outside one, as the person's own sessions are.
fn group_of(listing: &SessionListing) -> String {
    let home = listing
        .git
        .as_ref()
        .map_or_else(|| listing.info.cwd.clone(), |git| git.repo.clone());
    home.file_name().map_or_else(
        || home.display().to_string(),
        |name| name.to_string_lossy().into_owned(),
    )
}

/// What a tab runs: the TUI on the thread, with what finds the same Host.
fn tui_command(weave: &Path, session_id: &str) -> Vec<String> {
    let passed: Vec<String> = ["WEAVE_DAEMON_DIR", "XDG_STATE_HOME", "XDG_RUNTIME_DIR"]
        .iter()
        .filter_map(|name| {
            std::env::var(name)
                .ok()
                .filter(|value| !value.is_empty())
                .map(|value| format!("{name}={value}"))
        })
        .collect();
    let mut command = Vec::new();
    if !passed.is_empty() {
        command.push("/usr/bin/env".to_owned());
        command.extend(passed);
    }
    command.push(weave.display().to_string());
    command.extend(["--resume".to_owned(), session_id.to_owned()]);
    command
}

/// A thread's tab.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
struct Tab {
    session: String,
    window: String,
    block: String,
    /// The label it was given.
    title: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
struct Entry {
    /// When the device opening the tab is for happened.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    opened_at: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    tab: Option<Tab>,
}

/// Which tab shows which thread, and the openings handled, by thread id.
struct Record {
    path: PathBuf,
    entries: BTreeMap<String, Entry>,
}

impl Record {
    fn load(path: PathBuf) -> Self {
        let entries = std::fs::read_to_string(&path)
            .ok()
            .and_then(|text| serde_json::from_str(&text).ok())
            .unwrap_or_default();
        Self { path, entries }
    }

    fn opening(&self, id: &str) -> Option<u64> {
        self.entries.get(id).and_then(|entry| entry.opened_at)
    }

    fn seen(&mut self, id: &str, at: u64) {
        self.entries.entry(id.to_owned()).or_default().opened_at = Some(at);
        self.save();
    }

    fn tab(&self, id: &str) -> Option<&Tab> {
        self.entries.get(id).and_then(|entry| entry.tab.as_ref())
    }

    fn put(&mut self, id: &str, tab: Tab) {
        self.entries.entry(id.to_owned()).or_default().tab = Some(tab);
        self.save();
    }

    fn forget(&mut self, id: &impl std::fmt::Display) {
        if self.entries.remove(&id.to_string()).is_some() {
            self.save();
        }
    }

    fn save(&self) {
        if let Ok(text) = serde_json::to_string_pretty(&self.entries) {
            let _ = std::fs::write(&self.path, text);
        }
    }
}

/// The `rex` CLI, never starting a server.
struct Rex {
    rex: PathBuf,
}

/// What `rex new` or `rex window new` made.
struct Created {
    session: String,
    window: String,
    block: String,
}

impl Rex {
    fn new(rex: PathBuf) -> Self {
        Self { rex }
    }

    /// Whether the server `rex` reaches is this computer's, by its local socket.
    fn is_local(&self) -> anyhow::Result<bool> {
        let whoami: serde_json::Value = serde_json::from_str(&self.run(&["whoami", "--json"])?)?;
        Ok(whoami["endpoint"]
            .as_str()
            .is_some_and(|endpoint| endpoint.starts_with("unix:")))
    }

    fn session_labelled(&self, label: &str) -> anyhow::Result<Option<String>> {
        let listed: serde_json::Value = serde_json::from_str(&self.run(&["ls", "--json"])?)?;
        Ok(listed["sessions"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|session| session["label"].as_str() == Some(label))
            .and_then(|session| session["session_id"].as_str())
            .map(str::to_owned))
    }

    fn has_block(&self, session: &str, block: &str) -> bool {
        self.run(&["block", "ls", "-s", session, "--json"])
            .ok()
            .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
            .is_some_and(|listed| {
                listed["blocks"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .any(|listed| listed["block_id"].as_str() == Some(block))
            })
    }

    fn new_session(
        &self,
        label: &str,
        title: &str,
        cwd: &str,
        command: &[String],
    ) -> anyhow::Result<Created> {
        let mut args = vec!["new", label, "-c", cwd, "--window", title, "--json", "--"];
        args.extend(command.iter().map(String::as_str));
        let created: serde_json::Value = serde_json::from_str(&self.run(&args)?)?;
        let window = &created["initial_windows"][0];
        Ok(Created {
            session: text(&created["session_id"])?,
            window: text(&window["window_id"])?,
            block: text(&window["block_ids"][0])?,
        })
    }

    fn new_window(
        &self,
        session: &str,
        title: &str,
        cwd: &str,
        command: &[String],
    ) -> anyhow::Result<Created> {
        let mut args = vec![
            "window",
            "new",
            "-s",
            session,
            title,
            "-c",
            cwd,
            "--focus=false",
            "--json",
            "--",
        ];
        args.extend(command.iter().map(String::as_str));
        let created: serde_json::Value = serde_json::from_str(&self.run(&args)?)?;
        Ok(Created {
            session: session.to_owned(),
            window: text(&created["window_id"])?,
            block: text(&created["block_ids"][0])?,
        })
    }

    fn rename_window(&self, session: &str, window: &str, title: &str) -> anyhow::Result<()> {
        self.run(&["window", "rename", "-s", session, window, title])
            .map(drop)
    }

    fn run(&self, args: &[&str]) -> anyhow::Result<String> {
        let output = Command::new(&self.rex)
            .arg("--autostart=false")
            .args(args)
            .output()
            .with_context(|| format!("running {}", self.rex.display()))?;
        if !output.status.success() {
            anyhow::bail!(
                "rex {}: {}",
                args.first().copied().unwrap_or_default(),
                String::from_utf8_lossy(&output.stderr).trim()
            );
        }
        Ok(String::from_utf8_lossy(&output.stdout).into_owned())
    }
}

fn text(value: &serde_json::Value) -> anyhow::Result<String> {
    value
        .as_str()
        .map(str::to_owned)
        .context("rex didn't say what it made")
}

/// `rex` on `path`, a `PATH` such as the login shell's.
pub fn find_rex(path: &str) -> Option<PathBuf> {
    std::env::split_paths(path)
        .map(|dir| dir.join("rex"))
        .find(|candidate| candidate.is_file())
}

#[cfg(test)]
mod tests {
    use pretty_assertions::assert_eq;
    use weave_acp_core::schema::SessionInfo;
    use weave_host_protocol::worktrees::GitLocation;

    use super::*;

    /// A `rex` that logs its arguments and answers as Rex would, with `sessions` labelled.
    fn fake_rex(dir: &Path, sessions: &[(&str, &str)], blocks: &[&str]) -> PathBuf {
        let rex = dir.join("rex");
        let sessions: Vec<String> = sessions
            .iter()
            .map(|(id, label)| format!(r#"{{"session_id": "{id}", "label": "{label}"}}"#))
            .collect();
        let blocks: Vec<String> = blocks
            .iter()
            .map(|block| format!(r#"{{"block_id": "{block}"}}"#))
            .collect();
        let script = format!(
            "#!/bin/sh\necho \"$@\" >> '{log}'\ncase \"$2\" in\n  \
             whoami) echo '{{\"endpoint\": \"unix:///tmp/rex.sock\"}}' ;;\n  \
             ls) echo '{{\"sessions\": [{sessions}]}}' ;;\n  \
             new) echo '{{\"session_id\": \"session:new\", \"initial_windows\": [{{\"window_id\": \"window:first\", \"block_ids\": [\"block:first\"]}}]}}' ;;\n  \
             window) [ \"$3\" = new ] && echo '{{\"window_id\": \"window:more\", \"block_ids\": [\"block:more\"]}}' ;;\n  \
             block) echo '{{\"blocks\": [{blocks}]}}' ;;\n\
             esac\n",
            log = dir.join("log").display(),
            sessions = sessions.join(", "),
            blocks = blocks.join(", "),
        );
        std::fs::write(&rex, script).expect("rex");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&rex, std::fs::Permissions::from_mode(0o755)).expect("mode");
        }
        rex
    }

    fn follower(dir: &Path, sessions: &[(&str, &str)], blocks: &[&str]) -> Follower {
        Follower {
            rex: Rex::new(fake_rex(dir, sessions, blocks)),
            record: Record::load(dir.join("rex-threads.json")),
            weave: Some(PathBuf::from("/bin/weave")),
        }
    }

    fn log(dir: &Path) -> Vec<String> {
        std::fs::read_to_string(dir.join("log"))
            .unwrap_or_default()
            .lines()
            .map(str::to_owned)
            .collect()
    }

    fn listing(
        id: &str,
        title: Option<&str>,
        opened: Option<(Option<&str>, u64)>,
    ) -> SessionListing {
        let mut info = SessionInfo::new(id.to_owned(), "/code/weave.feature");
        info.title = title.map(str::to_owned);
        SessionListing {
            info,
            agent_id: "claude".to_owned(),
            state: SessionStatus::Open,
            activity: None,
            clients: 1,
            headless: false,
            last_activity_at: None,
            git: Some(GitLocation {
                repo: "/code/weave".into(),
                worktree: "/code/weave.feature".into(),
                branch: Some("feature".to_owned()),
                remote: None,
            }),
            started_by: None,
            started_by_host: None,
            opened_by: opened.map(|(device, _)| TurnOrigin::Client {
                name: "weave-app".to_owned(),
                id: "c9".to_owned(),
                device: device.map(str::to_owned),
            }),
            opened_at: opened.map(|(_, at)| at),
            continued_in: None,
        }
    }

    #[test]
    fn a_thread_a_device_opens_gets_a_tab_in_its_repositorys_session_once() {
        let dir = tempfile::tempdir().expect("tempdir");
        let mut follower = follower(dir.path(), &[("session:weave", "weave")], &[]);
        let opened = listing(
            "s-1",
            Some("Fix the parser"),
            Some((Some("Jaco's iPad"), 10)),
        );
        follower.updated(&opened);
        // The same opening again, as the thread changes, makes no second tab.
        follower.updated(&opened);
        let lines = log(dir.path());
        let made: Vec<&String> = lines
            .iter()
            .filter(|line| line.contains("window new"))
            .collect();
        assert_eq!(made.len(), 1, "{lines:?}");
        assert_eq!(
            made[0],
            "--autostart=false window new -s session:weave Fix the parser -c /code/weave.feature \
             --focus=false --json -- /bin/weave --resume s-1"
        );
        assert_eq!(
            follower.record.tab("s-1").map(|tab| tab.block.as_str()),
            Some("block:more")
        );

        // Renamed, its tab follows.
        follower.updated(&listing(
            "s-1",
            Some("Parser fixed"),
            Some((Some("Jaco's iPad"), 10)),
        ));
        assert!(
            log(dir.path())
                .last()
                .is_some_and(|line| line
                    .ends_with("window rename -s session:weave window:more Parser fixed")),
            "{:?}",
            log(dir.path())
        );
    }

    #[test]
    fn a_repository_without_a_session_gets_one_and_a_tab_still_there_isnt_doubled() {
        let dir = tempfile::tempdir().expect("tempdir");
        let mut follower = follower(dir.path(), &[], &["block:first"]);
        follower.updated(&listing("s-1", None, Some((Some("iPad"), 10))));
        assert!(
            log(dir.path()).iter().any(|line| line.starts_with(
                "--autostart=false new weave -c /code/weave.feature --window New thread --json --"
            )),
            "{:?}",
            log(dir.path())
        );
        // Opened again from the app while its tab is still in Rex.
        follower.updated(&listing("s-1", None, Some((Some("iPad"), 20))));
        let made = log(dir.path())
            .iter()
            .filter(|line| line.contains(" new "))
            .count();
        assert_eq!(made, 1);
    }

    #[test]
    fn only_a_devices_openings_count_and_ones_from_before_stay_as_they_are() {
        let dir = tempfile::tempdir().expect("tempdir");
        let mut follower = follower(dir.path(), &[("session:weave", "weave")], &[]);
        // From a local client, or a run.
        follower.updated(&listing("s-1", None, Some((None, 10))));
        follower.updated(&listing("s-2", None, None));
        // There already when the follower started.
        let before = listing("s-3", None, Some((Some("iPad"), 5)));
        follower.seen(&before);
        follower.updated(&before);
        assert!(
            !log(dir.path()).iter().any(|line| line.contains("new")),
            "{:?}",
            log(dir.path())
        );
    }
}
