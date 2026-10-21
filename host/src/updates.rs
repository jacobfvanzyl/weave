//! Newer versions of the agents sessions run (WVE-93). When a session opens, the Host looks
//! for one in the background: npm's `latest` for a preset's package, the ACP registry's catalog
//! for a registry agent. A lookup serves every session for an hour, so sessions opened together
//! make one request, and one that failed shows nothing. Sessions of the agent that run an older
//! version are told, and tell their clients.
//!
//! `agents/update` moves the agent's new sessions to the newest version through
//! `weave_agents::update`, as `weave update` does, checking that it starts with the Host's own
//! launcher and environment; `session/reopen` moves an open one.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Mutex;
use std::time::Duration;
use std::time::Instant;

use agent_client_protocol::Error;
use tokio::sync::OnceCell;
use weave_acp_core::AgentSpec;
use weave_acp_core::ClientOptions;
use weave_agents::registry::Registry;
use weave_agents::update::BoxFuture;
use weave_agents::update::CHECK_TIMEOUT;
use weave_agents::update::Check;
use weave_agents::update::Outcome;
use weave_agents::update::Request;
use weave_host_protocol::agents::AgentSource;
use weave_host_protocol::errors;

use crate::Shared;
use crate::instance::Instance;
use crate::instance::Launch;
use crate::session::Command;
use crate::session::SessionHandle;
use crate::session::lock;

/// How long a lookup's answer serves.
const LOOKUP_TTL: Duration = Duration::from_secs(60 * 60);

/// Where newer versions of an agent are looked for.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub(crate) enum Feed {
    /// npm's `latest` for this package.
    Npm(String),
    /// The ACP registry's catalog, for the agent of this id.
    Registry(String),
}

impl Feed {
    /// Where to look for `source`'s agent `id`; none for agents the configuration gives a
    /// command, which are the user's to update.
    pub(crate) fn of(source: AgentSource, id: &str, package: Option<&str>) -> Option<Self> {
        match source {
            AgentSource::Preset => package.map(|package| Self::Npm(package.to_owned())),
            AgentSource::Registry => Some(Self::Registry(id.to_owned())),
            AgentSource::Config => None,
        }
    }

    /// The lookup it shares: the registry's agents share the catalog.
    fn key(&self) -> Key {
        match self {
            Self::Npm(package) => Key::Npm(package.clone()),
            Self::Registry(_) => Key::Catalog,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
enum Key {
    Npm(String),
    Catalog,
}

enum Found {
    Version(String),
    Catalog(Registry),
}

/// One lookup, shared by every session that opens while it serves.
struct Lookup {
    at: Instant,
    found: OnceCell<Option<Found>>,
}

#[derive(Default)]
pub(crate) struct Updates {
    lookups: Mutex<HashMap<Key, Arc<Lookup>>>,
    /// One `agents/update` at a time, as each rewrites the lock.
    updating: tokio::sync::Mutex<()>,
}

impl Updates {
    /// The newest version `feed` names, looked up unless a lookup under an hour old has the
    /// answer; none when that lookup failed.
    async fn latest(&self, shared: &Shared, feed: &Feed) -> Option<String> {
        let key = feed.key();
        let lookup = {
            let mut lookups = lock(&self.lookups);
            let stale = lookups
                .get(&key)
                .is_none_or(|lookup| lookup.at.elapsed() >= LOOKUP_TTL);
            if stale {
                lookups.insert(
                    key.clone(),
                    Arc::new(Lookup {
                        at: Instant::now(),
                        found: OnceCell::new(),
                    }),
                );
            }
            Arc::clone(lookups.get(&key)?)
        };
        let upstream = &shared.config.upstream;
        let found = lookup
            .found
            .get_or_init(|| async {
                let found = match &key {
                    Key::Npm(package) => upstream.latest(package).await.map(Found::Version),
                    Key::Catalog => upstream
                        .catalog()
                        .await
                        .map(|fetched| Found::Catalog(fetched.registry)),
                };
                found
                    .inspect_err(|error| {
                        tracing::debug!(error = %format!("{error:#}"), "looking for agent updates failed");
                    })
                    .ok()
            })
            .await;
        match (found.as_ref()?, feed) {
            (Found::Version(version), _) => Some(version.clone()),
            (Found::Catalog(registry), Feed::Registry(id)) => {
                registry.find(id).map(|agent| agent.version.clone())
            }
            (Found::Catalog(_), Feed::Npm(_)) => None,
        }
    }
}

/// Look for a newer version of `session`'s agent in the background, and tell the agent's
/// sessions if there is one.
pub(crate) fn look_for_update(shared: &Arc<Shared>, session: &SessionHandle) {
    let Some(feed) = session.feed.clone() else {
        return;
    };
    let shared = Arc::clone(shared);
    let agent_id = session.agent_id.clone();
    tokio::spawn(async move {
        if let Some(latest) = shared.updates.latest(&shared, &feed).await {
            offer(&shared, &agent_id, &latest);
        }
    });
}

/// Tell the open sessions of `agent_id` about `latest`; those running older ones tell their
/// clients.
fn offer(shared: &Shared, agent_id: &str, latest: &str) {
    let sessions: Vec<SessionHandle> = shared
        .registry()
        .sessions
        .values()
        .filter(|session| session.agent_id == agent_id)
        .cloned()
        .collect();
    for session in sessions {
        let _ = session.send(Command::UpdateAvailable {
            latest: latest.to_owned(),
        });
    }
}

/// `agents/update`: what `weave update <agent>` does, checked with this Host's launcher.
/// Returns the version the agent's new sessions launch.
pub(crate) async fn update(shared: &Arc<Shared>, agent_id: &str) -> Result<String, Error> {
    let agent = shared.resolve(agent_id).await?;
    if agent.source == AgentSource::Config {
        return Err(Error::invalid_params().data(format!(
            "{agent_id} runs the command its configuration gives, so updating it is yours to do"
        )));
    }
    let _one = shared.updates.updating.lock().await;
    let internal = |error: anyhow::Error| Error::internal_error().data(format!("{error:#}"));
    let loaded =
        weave_agents::Config::load(shared.config.config_file.as_deref()).map_err(internal)?;
    let lock_path = loaded.lock_path.ok_or_else(|| {
        Error::internal_error().data("no config directory to keep agents.lock in")
    })?;
    let request = Request {
        agents: vec![agent_id.to_owned()],
        dry_run: false,
        reset: false,
    };
    let report = weave_agents::update::update(
        &request,
        &loaded.config,
        &lock_path,
        &shared.registry_cache()?,
        shared.config.upstream.as_ref(),
        &Starts { shared },
    )
    .await
    .map_err(internal)?;
    let entry = report
        .agents
        .into_iter()
        .next()
        .ok_or_else(|| errors::unknown_agent(agent_id))?;
    let version = match entry.outcome {
        Outcome::Updated | Outcome::Current => entry.to.or(entry.from),
        Outcome::Failed => {
            let note = entry.note.unwrap_or_else(|| "it failed".to_owned());
            return Err(Error::internal_error().data(format!("couldn't update {agent_id}: {note}")));
        }
        _ => None,
    }
    .ok_or_else(|| Error::internal_error().data(format!("{agent_id} has no version to update")))?;
    // The next sessions start the new version, not a spare of the old one.
    shared.drop_spares(agent_id);
    offer(shared, agent_id, &version);
    Ok(version)
}

/// Start the agent as this Host starts agents, in the home directory, and wait for its
/// `initialize` answer.
struct Starts<'a> {
    shared: &'a Shared,
}

impl Check for Starts<'_> {
    fn check<'a>(
        &'a self,
        spec: &'a AgentSpec,
        options: &'a ClientOptions,
    ) -> BoxFuture<'a, anyhow::Result<()>> {
        Box::pin(async move {
            let launch = Launch {
                agent_id: "update".to_owned(),
                spec: spec.clone(),
                cwd: crate::client::home(),
                environment: self.shared.config.environment.vars.clone(),
            };
            let started = tokio::time::timeout(
                CHECK_TIMEOUT,
                Instance::start(&self.shared.config.launcher, &launch, *options),
            )
            .await;
            match started {
                Ok(Ok(instance)) => {
                    instance.connection.shutdown().await;
                    Ok(())
                }
                Ok(Err(error)) => Err(anyhow::anyhow!("{}", describe(&error))),
                Err(_) => anyhow::bail!(
                    "it didn't answer initialize within {} minutes",
                    CHECK_TIMEOUT.as_secs() / 60
                ),
            }
        })
    }
}

/// An error's message and data, as people read it.
pub(crate) fn describe(error: &Error) -> String {
    match error.data.as_ref() {
        Some(serde_json::Value::String(data)) => format!("{}: {data}", error.message),
        Some(data) => format!("{}: {data}", error.message),
        None => error.message.clone(),
    }
}
