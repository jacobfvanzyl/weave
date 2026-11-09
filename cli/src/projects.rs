//! The person's Projects (ADR 0031, WVE-189), which the Dispatcher keeps: asking it for them,
//! keeping the last list it gave in this computer's state directory for when it doesn't answer,
//! as while the homelab it runs on sleeps, and `--project`, which names a Project's location on
//! the Host a command works on. `weave projects` manages them
//! ([`crate::commands::projects`]).

use std::io::Write as _;
use std::path::PathBuf;

use anyhow::Context as _;
use anyhow::bail;
use serde::Deserialize;
use serde::Serialize;
use weave_dispatcher::DispatcherPaths;
use weave_dispatcher::client::DispatcherConnection;
use weave_dispatcher::paths::DIR_VARIABLE;
use weave_host_protocol::Timestamp;
use weave_host_protocol::dispatcher::ListHostsRequest;
use weave_host_protocol::dispatcher::ListProjectsRequest;
use weave_host_protocol::dispatcher::PROJECTS_FEATURE;
use weave_host_protocol::dispatcher::Project;

use crate::clock::ago;
use crate::clock::now_ms;
use crate::dispatcher;
use crate::paired;

/// A Host the Dispatcher knows, by its id and what it calls it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HostName {
    pub(crate) host_id: String,
    pub(crate) name: String,
}

/// The Projects the Dispatcher listed, with what it calls its Hosts.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Listed {
    pub(crate) projects: Vec<Project>,
    pub(crate) hosts: Vec<HostName>,
    /// When the Dispatcher gave them.
    pub(crate) listed_at: Timestamp,
    /// Kept from before because the Dispatcher didn't answer now, saying why.
    #[serde(skip)]
    pub(crate) offline: Option<String>,
}

impl Listed {
    /// What the Dispatcher calls the Host `host_id`, or its id when it doesn't know it.
    pub(crate) fn host_name<'a>(&'a self, host_id: &'a str) -> &'a str {
        self.hosts
            .iter()
            .find(|host| host.host_id == host_id)
            .map_or(host_id, |host| host.name.as_str())
    }

    /// The Host `by` names, by id or else name, ignoring case, as `hosts/list` gives them.
    pub(crate) fn host_id(&self, by: &str) -> Option<&str> {
        self.hosts
            .iter()
            .find(|host| host.host_id == by)
            .or_else(|| {
                self.hosts
                    .iter()
                    .find(|host| host.name.eq_ignore_ascii_case(by))
            })
            .map(|host| host.host_id.as_str())
    }

    /// The Project `by` names, by id or else name, ignoring case.
    pub(crate) fn find(&self, by: &str) -> anyhow::Result<&Project> {
        let folded = by.trim().to_lowercase();
        self.projects
            .iter()
            .find(|project| project.id == by)
            .or_else(|| {
                self.projects
                    .iter()
                    .find(|project| project.name.to_lowercase() == folded)
            })
            .with_context(|| format!("there's no Project {by}; `weave projects` lists them"))
    }

    /// For a list kept from before, a line saying how old it is and why: "The Dispatcher didn't
    /// answer, so these are the Projects it listed 3h ago (…)."
    pub(crate) fn note(&self, now: u64) -> Option<String> {
        self.offline.as_ref().map(|why| {
            format!(
                "The Dispatcher didn't answer, so these are the Projects it listed {} ago ({why}).",
                ago(now, self.listed_at)
            )
        })
    }

    /// As [`Self::note`], for a command that goes by the list rather than showing it.
    pub(crate) fn going_by(&self, now: u64) -> Option<String> {
        self.offline.as_ref().map(|why| {
            format!(
                "The Dispatcher didn't answer, so this goes by the Projects it listed {} ago \
                 ({why}).",
                ago(now, self.listed_at)
            )
        })
    }

    /// Where `project` is, in a message: "on homelab (/home/jaco/odin) and mac (/Users/…)", or
    /// "nowhere: …".
    pub(crate) fn whereabouts(&self, project: &Project) -> String {
        if project.locations.is_empty() {
            return "on no Host: those it was on have left the Dispatcher".to_owned();
        }
        let places: Vec<String> = project
            .locations
            .iter()
            .map(|location| {
                format!(
                    "{} ({})",
                    self.host_name(&location.host_id),
                    location.path.display()
                )
            })
            .collect();
        format!("on {}", places.join(" and "))
    }
}

/// The Projects, from the Dispatcher a command asks ([`dispatcher::reach`]), which this
/// computer keeps; or, when it doesn't answer, the last it kept, saying so.
pub(crate) async fn list(paths: &DispatcherPaths) -> anyhow::Result<Listed> {
    let reached = match dispatcher::reach(paths).await {
        Ok(reached) => reached,
        Err(error) => {
            return match kept() {
                Some(mut kept) => {
                    kept.offline = Some(format!("{error:#}"));
                    Ok(kept)
                }
                None => Err(error),
            };
        }
    };
    let listed = from(&reached.connection).await;
    reached.connection.shutdown().await;
    let listed = listed?;
    if let Err(error) = keep(&listed) {
        tracing::warn!(error = %format!("{error:#}"), "keeping the Projects for when the Dispatcher is away");
    }
    Ok(listed)
}

/// The Projects and Hosts `dispatcher` lists now.
pub(crate) async fn from(dispatcher: &DispatcherConnection) -> anyhow::Result<Listed> {
    offered(dispatcher)?;
    let projects = dispatcher.send(ListProjectsRequest {}).await?.projects;
    let hosts = dispatcher
        .send(ListHostsRequest {})
        .await?
        .hosts
        .into_iter()
        .map(|host| HostName {
            host_id: host.host_id,
            name: host.name,
        })
        .collect();
    Ok(Listed {
        projects,
        hosts,
        listed_at: now_ms(),
        offline: None,
    })
}

/// Fail unless `dispatcher` keeps Projects, as one from before WVE-189 doesn't.
pub(crate) fn offered(dispatcher: &DispatcherConnection) -> anyhow::Result<()> {
    if dispatcher.hello().offers(PROJECTS_FEATURE) {
        return Ok(());
    }
    bail!(
        "the Dispatcher runs weave {}, from before it kept Projects: update weave where it runs",
        dispatcher.hello().version
    )
}

/// Where this computer keeps the last Projects the Dispatcher listed: none for a Dispatcher
/// directory named with `$WEAVE_DISPATCHER_DIR`, as a development one is, so it never mixes
/// with the person's own.
fn kept_at() -> anyhow::Result<Option<PathBuf>> {
    if std::env::var_os(DIR_VARIABLE).is_some_and(|dir| !dir.is_empty()) {
        return Ok(None);
    }
    Ok(Some(paired::dir()?.join("projects.json")))
}

/// The Projects kept from the last list, if there are any.
pub(crate) fn kept() -> Option<Listed> {
    let path = kept_at().ok()??;
    let bytes = std::fs::read(&path).ok()?;
    serde_json::from_slice(&bytes).ok()
}

/// Keep `listed` for when the Dispatcher doesn't answer.
pub(crate) fn keep(listed: &Listed) -> anyhow::Result<()> {
    let Some(path) = kept_at()? else {
        return Ok(());
    };
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).with_context(|| format!("creating {}", dir.display()))?;
    }
    let json = serde_json::to_vec_pretty(listed)?;
    let temporary = path.with_extension("json.tmp");
    let written = (|| {
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt as _;
            options.mode(0o600);
        }
        let mut out = options.open(&temporary)?;
        out.write_all(&json)?;
        std::fs::rename(&temporary, &path)
    })();
    if written.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    written.with_context(|| format!("writing {}", path.display()))
}

/// Which Host `--project` names a directory on.
pub(crate) enum On<'a> {
    /// This computer's.
    Here,
    /// The one `--host` names, by id or name.
    Host(&'a str),
}

/// The directory `--project <by>` names on the Host `on`: the Project's location there, a git
/// Project's primary worktree. Refused, saying where the Project is and how to add a location
/// there, when it has none on that Host: it never moves to another Host.
pub(crate) async fn directory(by: &str, on: On<'_>) -> anyhow::Result<PathBuf> {
    let listed = list(&dispatcher::paths()?).await?;
    if let Some(note) = listed.going_by(now_ms()) {
        eprintln!("weave: {note}");
    }
    let project = listed.find(by)?;
    let (host_id, host) = match on {
        On::Here => (here()?, None),
        On::Host(host) => match listed.host_id(host) {
            Some(host_id) => (Some(host_id.to_owned()), Some(host)),
            // This computer's, by a name the Dispatcher's list didn't have.
            None if weave_host::known_as(&crate::host::paths()?)
                .iter()
                .any(|known| known.eq_ignore_ascii_case(host)) =>
            {
                (here()?, Some(host))
            }
            None => bail!("no Host called {host} has joined the Dispatcher"),
        },
    };
    if let Some(location) = host_id.as_deref().and_then(|id| project.location(id)) {
        return Ok(location.path.clone());
    }
    let (named, flag) = match (host, host_id.as_deref()) {
        (Some(host), _) => (host.to_owned(), format!(" --host {host}")),
        (None, Some(id)) if listed.host_id(id).is_some() => {
            (listed.host_name(id).to_owned(), String::new())
        }
        (None, _) => ("this computer's Host".to_owned(), String::new()),
    };
    bail!(
        "{} has no location on {named}: it's {}. `weave projects add --to {}{flag} <dir>` adds \
         one there",
        project.name,
        listed.whereabouts(project),
        project.name
    )
}

/// The id of this computer's Host, as its directory keeps it; none before it first ran.
fn here() -> anyhow::Result<Option<String>> {
    Ok(weave_host::own_id(&crate::host::paths()?))
}
